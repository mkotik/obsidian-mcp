/**
 * Per-note metadata: created / modified dates and tags, with a cache and a
 * small persistent "first seen" index.
 *
 * Where the dates come from
 * -------------------------
 * modified  — filesystem mtime. Authoritative: it moves on every edit from any
 *             device (Obsidian Sync preserves the source mtime on download).
 * created   — frontmatter `created:` when present and parseable, otherwise the
 *             earliest of (birthtime, mtime, first-seen index). Birthtime alone
 *             is not trustworthy on the VPS: every note's birthtime is the moment
 *             Obsidian Sync first downloaded it, and a sync that replaces a file
 *             resets it. Taking the minimum, and remembering it across restarts,
 *             keeps `created` from drifting forward.
 *
 * Frontmatter `updated:` is reported alongside but never preferred over mtime;
 * when the two disagree by more than a day the note is flagged, because a stale
 * hand-maintained `updated:` is exactly what makes ranking quietly wrong.
 */
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { splitFrontmatter, parseFrontmatter } from './frontmatter.js';
import { frontmatterTags, inlineTags, dedupe } from './tags.js';

export interface NoteMeta {
  path: string;
  bytes: number;
  /** ISO timestamp. */
  created: string;
  created_source: 'frontmatter' | 'filesystem';
  /** ISO timestamp (filesystem mtime). */
  modified: string;
  /** Frontmatter `updated:` as written, when present. */
  updated_frontmatter?: string;
  /** Set when frontmatter `updated:` and the real mtime differ by > 36h. */
  dates_mismatch?: true;
  tags: string[];
  /** Internal: epoch ms for sorting/filtering. Stripped before output. */
  createdMs: number;
  modifiedMs: number;
}

const DAY_MS = 86_400_000;

/**
 * Parse a frontmatter date value. Accepts YAML dates, `YYYY-MM-DD`, and
 * `YYYY-MM-DD[T ]HH:mm[:ss]` with optional zone. Placeholders such as
 * `YYYY-MM-DD` in a template return null and are ignored.
 */
export function parseNoteDate(value: unknown, timeZone: string): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, , zone] = m;
  if (zone) {
    const t = Date.parse(s.replace(' ', 'T'));
    return Number.isNaN(t) ? null : t;
  }
  // No zone: interpret as wall-clock time in the vault's timezone.
  return zonedToEpoch(+y, +mo, +d, h ? +h : 0, mi ? +mi : 0, sec ? +sec : 0, timeZone);
}

/** Convert a wall-clock time in `timeZone` to epoch ms (DST-correct). */
export function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - t;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

/** `YYYY-MM-DD` for an instant, in the vault's timezone. */
export function formatDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** `YYYY-MM-DDTHH:mm` for an instant, in the vault's timezone. */
export function formatDateTime(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** ISO-8601 with the vault timezone's offset, e.g. `2026-10-03T12:18:00-04:00`. */
export function formatIsoLocal(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const wall = Date.UTC(+g('year'), +g('month') - 1, +g('day'), +g('hour'), +g('minute'), +g('second'));
  const offMin = Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}${off}`;
}

/**
 * Parse a filter bound supplied by a client: `YYYY-MM-DD`, an ISO timestamp, or
 * a relative form like `7d`, `2w`, `3m`, `1y` (meaning "that long ago").
 * `endOfDay` makes a bare date inclusive when used as an upper bound.
 */
export function parseDateFilter(input: string, timeZone: string, endOfDay = false, now = Date.now()): number | null {
  const s = input.trim().toLowerCase();
  const rel = /^(\d{1,4})\s*([dwmy])$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { d: 1, w: 7, m: 30, y: 365 }[rel[2] as 'd' | 'w' | 'm' | 'y'];
    return now - n * unit * DAY_MS;
  }
  if (s === 'today') return parseDateFilter(formatDate(now, timeZone), timeZone, endOfDay, now);
  if (s === 'yesterday') return parseDateFilter(formatDate(now - DAY_MS, timeZone), timeZone, endOfDay, now);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const t = parseNoteDate(input.trim(), timeZone);
  if (t === null) return null;
  if (dateOnly && endOfDay) {
    return t + DAY_MS - 1; // inclusive end of that day (DST shifts are within tolerance)
  }
  return t;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  birthMs: number;
  meta: NoteMeta;
}

export interface NoteIndexOptions {
  root: string;
  timeZone: string;
  /** Directory for the persistent first-seen index. Omit to keep it in memory only. */
  stateDir?: string;
  maxFileBytes: number;
}

/**
 * Metadata cache keyed by vault-relative path. A note is re-read only when its
 * mtime or size changes, so listing a few hundred notes stays cheap.
 */
export class NoteIndex {
  private cache = new Map<string, CacheEntry>();
  private firstSeen = new Map<string, number>();
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly statePath: string | null;

  private constructor(private readonly opts: NoteIndexOptions) {
    this.statePath = opts.stateDir ? path.join(opts.stateDir, 'first-seen.json') : null;
  }

  static async open(opts: NoteIndexOptions): Promise<NoteIndex> {
    const idx = new NoteIndex(opts);
    if (idx.statePath) {
      try {
        const raw = JSON.parse(await readFile(idx.statePath, 'utf8')) as Record<string, number>;
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') idx.firstSeen.set(k, v);
      } catch {
        // First run, or unreadable state: start empty. Dates still come from the filesystem.
      }
    }
    return idx;
  }

  get persistent(): boolean {
    return this.statePath !== null;
  }

  /** Metadata for one note, or null when it is missing or unreadable. */
  async get(rel: string, text?: string): Promise<NoteMeta | null> {
    const abs = path.join(this.opts.root, rel);
    let st;
    try {
      st = await stat(abs);
    } catch {
      this.cache.delete(rel);
      return null;
    }
    if (!st.isFile()) return null;

    const cached = this.cache.get(rel);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && text === undefined) {
      return cached.meta;
    }

    let body = text;
    if (body === undefined) {
      if (st.size > this.opts.maxFileBytes) {
        body = '';
      } else {
        try {
          body = await readFile(abs, 'utf8');
        } catch {
          return null;
        }
      }
    }

    const split = splitFrontmatter(body);
    const fm = parseFrontmatter(split);
    const tags = dedupe([...frontmatterTags(fm), ...inlineTags(split.body)]);

    const birthMs = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    let fsCreated = Math.min(birthMs, st.mtimeMs);
    const seen = this.firstSeen.get(rel);
    if (seen !== undefined && seen < fsCreated) fsCreated = seen;
    if (seen === undefined || fsCreated < seen) {
      this.firstSeen.set(rel, fsCreated);
      this.scheduleFlush();
    }

    const fmCreated = parseNoteDate(fm?.created, this.opts.timeZone);
    const fmUpdatedRaw = fm?.updated ?? fm?.modified;
    const fmUpdated = parseNoteDate(fmUpdatedRaw, this.opts.timeZone);

    const meta: NoteMeta = {
      path: rel,
      bytes: st.size,
      created: formatIsoLocal(fmCreated ?? fsCreated, this.opts.timeZone),
      created_source: fmCreated !== null ? 'frontmatter' : 'filesystem',
      modified: formatIsoLocal(st.mtimeMs, this.opts.timeZone),
      tags,
      createdMs: fmCreated ?? fsCreated,
      modifiedMs: st.mtimeMs,
    };
    if (fmUpdatedRaw !== undefined && fmUpdatedRaw !== null) {
      meta.updated_frontmatter = fmUpdatedRaw instanceof Date ? fmUpdatedRaw.toISOString().slice(0, 10) : String(fmUpdatedRaw);
      // Date-only values are compared at day granularity, so allow a day of slack.
      if (fmUpdated !== null && Math.abs(fmUpdated - st.mtimeMs) > 1.5 * DAY_MS) meta.dates_mismatch = true;
    }

    this.cache.set(rel, { mtimeMs: st.mtimeMs, size: st.size, birthMs, meta });
    return meta;
  }

  /** Metadata for many notes; missing ones are skipped. */
  async getMany(rels: readonly string[]): Promise<NoteMeta[]> {
    const out: NoteMeta[] = [];
    // Bounded concurrency: fast on a few hundred notes, gentle on a few thousand.
    const queue = [...rels];
    const workers = Array.from({ length: 16 }, async () => {
      for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
        const m = await this.get(rel);
        if (m) out.push(m);
      }
    });
    await Promise.all(workers);
    return out;
  }

  /** Earliest known filesystem creation time for a path (used before overwriting). */
  firstSeenFor(rel: string): number | undefined {
    return this.firstSeen.get(rel);
  }

  /** Carry first-seen history across a move so created dates survive renames. */
  recordMove(moved: ReadonlyMap<string, string>): void {
    for (const [from, to] of moved) {
      const seen = this.firstSeen.get(from);
      if (seen !== undefined) {
        const existing = this.firstSeen.get(to);
        this.firstSeen.set(to, existing === undefined ? seen : Math.min(seen, existing));
      }
      this.cache.delete(from);
      this.cache.delete(to);
    }
    this.scheduleFlush();
  }

  forget(rel: string): void {
    this.cache.delete(rel);
  }

  private scheduleFlush(): void {
    if (!this.statePath) return;
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flush(), 2000);
    this.flushTimer.unref();
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.statePath || !this.dirty) return;
    this.dirty = false;
    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(this.firstSeen)), { mode: 0o600 });
      await rename(tmp, this.statePath);
    } catch {
      // Losing the index costs only created-date precision; never fail a request over it.
    }
  }
}

/** Strip internal sort keys before sending metadata to a client. */
export function publicMeta(m: NoteMeta): Omit<NoteMeta, 'createdMs' | 'modifiedMs'> {
  const { createdMs: _c, modifiedMs: _m, ...rest } = m;
  return rest;
}

/**
 * Recency weight in (0, 1]: 1 for a note touched just now, 0.5 after one
 * half-life, and so on. Used to make recently changed notes rank higher.
 */
export function recencyWeight(modifiedMs: number, halfLifeDays: number, now = Date.now()): number {
  const ageDays = Math.max(0, (now - modifiedMs) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}
