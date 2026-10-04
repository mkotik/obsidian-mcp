#!/usr/bin/env node
/**
 * One-time backfill of access stats from the server's own log history.
 *
 * Every read_note / write_note / append_note / patch_note call has always been
 * logged with its path and timestamp, so past LLM activity can be replayed into
 * STATE_DIR/access.json. Moves are replayed in order so history follows renames;
 * paths that no longer exist in the vault are dropped at the end.
 *
 * Stop the service first (it rewrites access.json from memory), then:
 *
 *   journalctl -u obsidian-mcp -o cat --no-pager | \
 *     STATE_DIR=/var/lib/obsidian-mcp VAULT_ROOT=~/vaults/main node scripts/backfill-access.mjs
 *
 * Existing access.json entries are kept; replayed events are added to them.
 * Pass DRY_RUN=1 to print a summary without writing.
 */
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { AccessTracker } from '../dist/activity.js';

const STATE_DIR = process.env.STATE_DIR;
const VAULT = process.env.VAULT_ROOT;
const DRY = process.env.DRY_RUN === '1';
if (!STATE_DIR || !VAULT) {
  console.error('STATE_DIR and VAULT_ROOT are required');
  process.exit(2);
}

const tracker = await AccessTracker.open({ stateDir: STATE_DIR, halfLifeDays: 14, ignorePrefixes: ['.trash/'] });
const before = tracker.size;

const LINE = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] (read_note|write_note|append_note|patch_note|move_note|delete_note) (.*)$/;
const field = (rest, name) => {
  const m = rest.match(new RegExp(`(?:^| )${name}=("(?:[^"\\\\]|\\\\.)*")`));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
};

const counts = { read: 0, edit: 0, move: 0, delete: 0, lines: 0 };
let firstTs = null;
let lastTs = null;
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const m = line.match(LINE);
  if (!m) continue;
  counts.lines += 1;
  const at = Date.parse(m[1]);
  if (Number.isNaN(at)) continue;
  firstTs ??= m[1];
  lastTs = m[1];
  const [, , event, rest] = m;
  if (event === 'move_note') {
    const from = field(rest, 'from');
    const to = field(rest, 'to');
    if (from && to) {
      // Directory moves: carry every tracked note under the old prefix.
      const map = new Map([[from, to]]);
      for (const p of tracker.paths()) if (p.startsWith(`${from}/`)) map.set(p, `${to}/${p.slice(from.length + 1)}`);
      tracker.recordMove(map);
      counts.move += 1;
    }
    continue;
  }
  const p = field(rest, 'path');
  if (!p) continue;
  if (event === 'delete_note') {
    if (/permanent=true/.test(rest)) tracker.forget(p);
    counts.delete += 1;
  } else if (event === 'read_note') {
    tracker.record(p, 'read', at);
    counts.read += 1;
  } else {
    tracker.record(p, 'edit', at);
    counts.edit += 1;
  }
}

// Keep only notes that still exist (soft deletes went to .trash and are pruned later).
let dropped = 0;
for (const p of tracker.paths()) {
  if (p.startsWith('.trash/')) continue;
  try {
    const st = await stat(path.join(VAULT, p));
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    tracker.forget(p);
    dropped += 1;
  }
}

console.log(
  JSON.stringify({ log_range: [firstTs, lastTs], events: counts, notes_before: before, notes_after: tracker.size, dropped_missing: dropped, dry_run: DRY })
);
if (!DRY) {
  tracker.markDirty();
  await tracker.flush();
}
