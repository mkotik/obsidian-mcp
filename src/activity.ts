/**
 * Per-note access tracking: when each note was last read or edited through
 * this server, how often, and a decayed "how much do I use this" frequency.
 *
 * Only activity that goes through the MCP server is visible here (an LLM
 * reading or writing a note). Opening a note in the Obsidian app is not seen.
 *
 * Persisted to STATE_DIR/access.json (mode 0600) with a debounced atomic write.
 * Stored per path: first/last access, lifetime counts, and daily buckets for
 * the last BUCKET_DAYS days. Paths and counts only, never note contents.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 86_400_000;
/** Daily buckets older than this are dropped (lifetime totals are kept). */
export const BUCKET_DAYS = 90;
/** Window for the `access_30d` count. */
export const WINDOW_DAYS = 30;

export type AccessKind = 'read' | 'edit';

interface Entry {
  /** First and last read/edit, epoch ms. */
  first: number;
  last: number;
  reads: number;
  edits: number;
  /** Times the note was returned in search results (not part of ranking). */
  searchHits: number;
  lastSearchHit?: number;
  /** UTC day index -> reads + edits that day. */
  days: Record<string, number>;
}

export interface AccessStats {
  /** ISO time of the last read or edit through the server, or null if never. */
  last_accessed: string | null;
  /** Reads + edits in the last 30 days. */
  access_30d: number;
  /** Lifetime reads + edits since tracking began. */
  access_total: number;
}

export interface AccessTrackerOptions {
  /** Directory for access.json. Omit to keep stats in memory only. */
  stateDir?: string;
  /** Half-life of the frequency score, in days. */
  halfLifeDays: number;
  /** Paths under these prefixes are never recorded (e.g. ".trash/"). */
  ignorePrefixes?: string[];
  now?: () => number;
}

const dayIndex = (ms: number): number => Math.floor(ms / DAY_MS);

export class AccessTracker {
  private entries = new Map<string, Entry>();
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly statePath: string | null;
  private readonly now: () => number;

  private constructor(private readonly opts: AccessTrackerOptions) {
    this.statePath = opts.stateDir ? path.join(opts.stateDir, 'access.json') : null;
    this.now = opts.now ?? Date.now;
  }

  static async open(opts: AccessTrackerOptions): Promise<AccessTracker> {
    const t = new AccessTracker(opts);
    if (t.statePath) {
      try {
        const raw = JSON.parse(await readFile(t.statePath, 'utf8')) as { notes?: Record<string, Entry> };
        for (const [k, v] of Object.entries(raw.notes ?? {})) {
          if (!v || typeof v !== 'object') continue;
          // "Never accessed" (search hits only) is stored as null.
          const first = typeof v.first === 'number' ? v.first : Number.NaN;
          const last = typeof v.last === 'number' ? v.last : Number.NaN;
          if (!Number.isNaN(last) || Number(v.searchHits) > 0) {
            t.entries.set(k, {
              first,
              last,
              reads: Number(v.reads) || 0,
              edits: Number(v.edits) || 0,
              searchHits: Number(v.searchHits) || 0,
              ...(typeof v.lastSearchHit === 'number' ? { lastSearchHit: v.lastSearchHit } : {}),
              days: v.days && typeof v.days === 'object' ? { ...v.days } : {},
            });
          }
        }
      } catch {
        // First run or unreadable state: start empty.
      }
    }
    return t;
  }

  get persistent(): boolean {
    return this.statePath !== null;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Tracked paths (snapshot). */
  paths(): string[] {
    return [...this.entries.keys()];
  }

  /** Force the next flush to write (used by the backfill script). */
  markDirty(): void {
    this.dirty = true;
  }

  private ignored(rel: string): boolean {
    return (this.opts.ignorePrefixes ?? []).some((p) => rel === p.replace(/\/$/, '') || rel.startsWith(p));
  }

  private entry(rel: string, at: number): Entry {
    let e = this.entries.get(rel);
    if (!e) {
      e = { first: at, last: at, reads: 0, edits: 0, searchHits: 0, days: {} };
      this.entries.set(rel, e);
    }
    return e;
  }

  /** Record a read or edit of a note. */
  record(rel: string, kind: AccessKind, at = this.now()): void {
    if (!rel || this.ignored(rel)) return;
    const e = this.entry(rel, at);
    e.first = Math.min(e.first, at);
    e.last = Math.max(e.last, at);
    if (kind === 'read') e.reads += 1;
    else e.edits += 1;
    const d = String(dayIndex(at));
    e.days[d] = (e.days[d] ?? 0) + 1;
    this.prune(e, at);
    this.scheduleFlush();
  }

  /** Record that notes were returned as search results. Counted, but not used for ranking. */
  recordSearchHits(rels: readonly string[], at = this.now()): void {
    let any = false;
    for (const rel of rels) {
      if (!rel || this.ignored(rel)) continue;
      const existing = this.entries.get(rel);
      if (existing) {
        existing.searchHits += 1;
        existing.lastSearchHit = at;
      } else {
        // A search hit alone does not count as an access: no first/last/days.
        this.entries.set(rel, { first: Number.NaN, last: Number.NaN, reads: 0, edits: 0, searchHits: 1, lastSearchHit: at, days: {} });
      }
      any = true;
    }
    if (any) this.scheduleFlush();
  }

  /** Carry stats across moves/renames so history follows the note. */
  recordMove(moved: ReadonlyMap<string, string>): void {
    for (const [from, to] of moved) {
      const src = this.entries.get(from);
      if (!src) continue;
      this.entries.delete(from);
      // Moves into .trash keep their history so a restore brings it back;
      // .trash paths never appear in listings or receive new accesses.
      const dst = this.entries.get(to);
      if (!dst) {
        this.entries.set(to, src);
        continue;
      }
      const merged: Entry = {
        first: minDefined(dst.first, src.first),
        last: maxDefined(dst.last, src.last),
        reads: dst.reads + src.reads,
        edits: dst.edits + src.edits,
        searchHits: dst.searchHits + src.searchHits,
        days: { ...dst.days },
      };
      const lsh = maxDefined(dst.lastSearchHit ?? Number.NaN, src.lastSearchHit ?? Number.NaN);
      if (!Number.isNaN(lsh)) merged.lastSearchHit = lsh;
      for (const [d, n] of Object.entries(src.days)) merged.days[d] = (merged.days[d] ?? 0) + n;
      this.entries.set(to, merged);
    }
    this.scheduleFlush();
  }

  /** Drop stats for a path (permanent delete). */
  forget(rel: string): void {
    if (this.entries.delete(rel)) this.scheduleFlush();
  }

  /** Epoch ms of the last read/edit, or null. */
  lastAccessMs(rel: string): number | null {
    const e = this.entries.get(rel);
    return e && !Number.isNaN(e.last) ? e.last : null;
  }

  /** Decayed access score: sum over days of count * 0.5^(age/halfLife). */
  score(rel: string, at = this.now()): number {
    const e = this.entries.get(rel);
    if (!e) return 0;
    const today = dayIndex(at);
    let s = 0;
    for (const [d, n] of Object.entries(e.days)) {
      const age = Math.max(0, today - Number(d));
      if (age > BUCKET_DAYS) continue; // same window as storage, so pruning never shifts scores
      s += n * Math.pow(0.5, age / this.opts.halfLifeDays);
    }
    return s;
  }

  /**
   * Frequency weight in [0, 1): 1 - exp(-score/3). One read today ~0.28,
   * opened weekly for months ~0.55, daily ~0.99. Saturates so a note read
   * fifty times does not dominate ranking.
   */
  frequency(rel: string, at = this.now()): number {
    return 1 - Math.exp(-this.score(rel, at) / 3);
  }

  stats(rel: string, at = this.now()): AccessStats {
    const e = this.entries.get(rel);
    if (!e || Number.isNaN(e.last)) return { last_accessed: null, access_30d: 0, access_total: 0 };
    const since = dayIndex(at) - (WINDOW_DAYS - 1);
    let w = 0;
    for (const [d, n] of Object.entries(e.days)) if (Number(d) >= since) w += n;
    return { last_accessed: new Date(e.last).toISOString(), access_30d: w, access_total: e.reads + e.edits };
  }

  /** Extended stats for read_note. */
  detail(rel: string, at = this.now()): AccessStats & { reads: number; edits: number; search_hits: number; first_accessed: string | null } {
    const e = this.entries.get(rel);
    return {
      ...this.stats(rel, at),
      reads: e?.reads ?? 0,
      edits: e?.edits ?? 0,
      search_hits: e?.searchHits ?? 0,
      first_accessed: e && !Number.isNaN(e.first) ? new Date(e.first).toISOString() : null,
    };
  }

  private prune(e: Entry, at: number): void {
    const cutoff = dayIndex(at) - BUCKET_DAYS;
    for (const d of Object.keys(e.days)) if (Number(d) < cutoff) delete e.days[d];
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
    const at = this.now();
    for (const [rel, e] of this.entries) {
      this.prune(e, at);
      // Trashed notes keep history for a restore, but not forever.
      const lastSeen = Math.max(Number.isNaN(e.last) ? 0 : e.last, e.lastSearchHit ?? 0);
      if (this.ignored(rel) && at - lastSeen > BUCKET_DAYS * DAY_MS) this.entries.delete(rel);
    }
    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      const notes: Record<string, Entry> = {};
      for (const [k, v] of this.entries) notes[k] = v;
      // NaN is not valid JSON; JSON.stringify writes "never accessed" as null.
      await writeFile(tmp, JSON.stringify({ version: 1, notes }), { mode: 0o600 });
      await rename(tmp, this.statePath);
    } catch {
      // Losing access stats costs only ranking precision; never fail a request over it.
    }
  }
}

function minDefined(a: number, b: number): number {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return Math.min(a, b);
}
function maxDefined(a: number, b: number): number {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return Math.max(a, b);
}
