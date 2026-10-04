/**
 * Verification for access-frequency tracking (v1.4): last_accessed /
 * access_30d / access_total on list/search/read results, the accessed /
 * frequency / stale sorts, accessed_* and touched_* filters, history carried
 * across moves and soft deletes, and frequency-aware search ranking.
 *
 * Part 1 unit-tests the tracker with a fake clock (needs a built dist/).
 * Part 2 drives the running server inside a throwaway subtree that is moved
 * to .trash/ at the end.
 *
 *   MCP_URL=http://127.0.0.1:3000/mcp MCP_ACCESS_JWT=<jwt> VAULT_ROOT=<vault> STATE_DIR=<state> node test/activity-verify.mjs
 *
 * VAULT_ROOT (optional) enables mtime backdating for the ranking/stale checks;
 * STATE_DIR (optional) enables the access.json persistence checks.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { utimes, stat, readFile, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AccessTracker } from '../dist/activity.js';

const URL_MCP = process.env.MCP_URL ?? 'http://127.0.0.1:3000/mcp';
const VAULT = process.env.VAULT_ROOT;
const STATE = process.env.STATE_DIR;
const headers = {};
if (process.env.MCP_BEARER) headers.authorization = `Bearer ${process.env.MCP_BEARER}`;
if (process.env.MCP_ACCESS_JWT) headers['cf-access-jwt-assertion'] = process.env.MCP_ACCESS_JWT;

const DAY = 86_400_000;
let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) passed += 1;
  else failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const payload = (r) => {
  try {
    return JSON.parse(r?.content?.[0]?.text ?? '');
  } catch {
    return { _raw: r?.content?.[0]?.text };
  }
};

// ------------------------------------------------------------------ part 1
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'acc-'));
  let clock = Date.UTC(2026, 9, 4, 12);
  const now = () => clock;
  const t = await AccessTracker.open({ stateDir: dir, halfLifeDays: 14, ignorePrefixes: ['.trash/'], now });

  check('unknown note: zero stats', JSON.stringify(t.stats('x.md')) === JSON.stringify({ last_accessed: null, access_30d: 0, access_total: 0 }));

  // Old note opened weekly for 6 months vs. a note written once in April.
  const start = clock;
  for (let w = 26; w >= 1; w--) t.record('weekly.md', 'read', start - w * 7 * DAY);
  t.record('april.md', 'edit', Date.UTC(2026, 3, 10));
  const fWeekly = t.frequency('weekly.md');
  const fApril = t.frequency('april.md');
  check('weekly-opened note has high frequency', fWeekly > 0.5 && fWeekly < 0.8, fWeekly.toFixed(3));
  check('once-in-April note has ~0 frequency', fApril < 0.01, fApril.toFixed(4));
  const recOld = Math.pow(0.5, 200 / 30);
  const wWeekly = 0.3 + 0.4 * recOld + 0.3 * fWeekly;
  const wApril = 0.3 + 0.4 * Math.pow(0.5, 177 / 30) + 0.3 * fApril;
  check('ranking weight: weekly old note beats April write-once', wWeekly > wApril + 0.15, `${wWeekly.toFixed(2)} vs ${wApril.toFixed(2)}`);

  const s = t.stats('weekly.md');
  check('access_total counts lifetime', s.access_total === 26, String(s.access_total));
  check('access_30d counts only the window', s.access_30d === 4 || s.access_30d === 5, String(s.access_30d));
  check('last_accessed is ISO of latest', s.last_accessed === new Date(start - 7 * DAY).toISOString());

  // Buckets older than 90 days are pruned, totals stay.
  await t.flush();
  const raw = JSON.parse(await readFile(path.join(dir, 'access.json'), 'utf8'));
  const dayKeys = Object.keys(raw.notes['weekly.md'].days).map(Number);
  check('daily buckets pruned to 90 days', Math.min(...dayKeys) >= Math.floor(clock / DAY) - 90);
  check('lifetime total survives pruning', raw.notes['weekly.md'].reads === 26);
  check('access.json is mode 0600', ((await stat(path.join(dir, 'access.json'))).mode & 0o777) === 0o600);

  // Search hits are counted but do not create access or frequency.
  t.recordSearchHits(['searched.md', 'weekly.md']);
  check('search hit alone is not an access', t.stats('searched.md').access_total === 0 && t.frequency('searched.md') === 0);
  check('search hit does not change frequency', t.frequency('weekly.md') === fWeekly);
  check('search hits tallied', t.detail('searched.md').search_hits === 1 && t.detail('weekly.md').search_hits === 1);

  // Trash paths ignored for new accesses; moves carry; moves into trash keep history for restore.
  t.record('.trash/2026/x.md', 'read');
  check('.trash reads ignored', t.stats('.trash/2026/x.md').access_total === 0);
  t.recordMove(new Map([['weekly.md', 'archive/weekly.md']]));
  check('move carries stats', t.stats('archive/weekly.md').access_total === 26 && t.stats('weekly.md').access_total === 0);
  t.record('dest.md', 'read');
  t.record('src.md', 'read');
  t.record('src.md', 'read');
  t.recordMove(new Map([['src.md', 'dest.md']]));
  check('move onto existing merges counts', t.stats('dest.md').access_total === 3);
  t.recordMove(new Map([['dest.md', '.trash/s/dest.md']]));
  t.recordMove(new Map([['.trash/s/dest.md', 'dest.md']]));
  check('trash + restore keeps history', t.stats('dest.md').access_total === 3);
  t.forget('dest.md');
  check('forget drops stats', t.stats('dest.md').access_total === 0);

  // Persistence round-trip, including a search-hit-only entry (null first/last).
  await t.flush();
  const t2 = await AccessTracker.open({ stateDir: dir, halfLifeDays: 14, now });
  check('reload keeps stats', t2.stats('archive/weekly.md').access_total === 26 && Math.abs(t2.frequency('archive/weekly.md') - fWeekly) < 1e-9);
  check('reload keeps search-hit-only entry as never-accessed', t2.detail('searched.md').search_hits === 1 && t2.stats('searched.md').last_accessed === null);

  // Decay over time: four weeks of no use quarters the score (a bit less, as the oldest days leave the 90-day window).
  const before = t2.score('archive/weekly.md');
  clock += 28 * DAY;
  const after = t2.score('archive/weekly.md');
  check('score decays with 14-day half-life', after / before > 0.2 && after / before <= 0.25 + 1e-9, (after / before).toFixed(3));

  // Memory-only mode does not throw.
  const mem = await AccessTracker.open({ halfLifeDays: 14 });
  mem.record('a.md', 'read');
  await mem.flush();
  check('memory-only tracker works', !mem.persistent && mem.stats('a.md').access_total === 1);
  await rm(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ part 2
const client = new Client({ name: 'activity-verify', version: '1.4.0' });
const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), { requestInit: { headers } });
const call = (name, args) => client.callTool({ name, arguments: args });
await client.connect(transport);

const ROOT = `_mcp_activity_test_${Date.now().toString(36)}`;
const A = `${ROOT}/alpha.md`;
const B = `${ROOT}/beta.md`;
const C = `${ROOT}/gamma.md`;
async function backdate(rel, daysAgo) {
  if (!VAULT) return false;
  const tm = new Date(Date.now() - daysAgo * DAY);
  await utimes(path.join(VAULT, rel), tm, tm);
  return true;
}

try {
  for (const p of [A, B, C]) {
    const w = payload(await call('write_note', { path: p, content: `# ${p}\n\nzebrafrequencyword here.\n` }));
    check(`write ${path.basename(p)}`, w.path === p, JSON.stringify(w).slice(0, 120));
  }

  const l0 = payload(await call('list_notes', { directory: ROOT }));
  const n0 = l0.notes.find((n) => n.path === A);
  check('list_notes carries access fields', n0 && 'last_accessed' in n0 && 'access_30d' in n0 && 'access_total' in n0, JSON.stringify(n0));
  check('a write counts as an access', n0?.access_total === 1 && n0?.last_accessed !== null);

  for (let i = 0; i < 3; i++) await call('read_note', { path: B });
  const r = payload(await call('read_note', { path: B }));
  check('read_note returns access detail', r.access?.reads === 4 && r.access?.edits === 1 && r.access?.access_total === 5, JSON.stringify(r.access));
  check('read_note access_30d', r.access?.access_30d === 5);

  const freq = payload(await call('list_notes', { directory: ROOT, sort: 'frequency', limit: 2 }));
  check('sort=frequency puts most-read first', freq.notes[0]?.path === B && freq.count === 2, freq.notes.map((n) => n.path).join(','));

  await call('read_note', { path: C });
  const acc = payload(await call('list_notes', { directory: ROOT, sort: 'accessed' }));
  check('sort=accessed puts last-read first', acc.notes[0]?.path === C, acc.notes.map((n) => n.path).join(','));

  const touched = payload(await call('list_notes', { directory: ROOT, touched_after: '7d' }));
  check('touched_after=7d finds this week\'s notes', touched.total_found === 3);
  const accAfter = payload(await call('list_notes', { directory: ROOT, accessed_after: '1d' }));
  check('accessed_after includes accessed notes', accAfter.total_found === 3);
  const bad = await call('list_notes', { directory: ROOT, touched_after: 'nonsense' });
  check('bad touched_after rejected', bad.isError === true);

  const s = payload(await call('search_notes', { query: 'zebrafrequencyword' }));
  const sb = s.results.find((x) => x.path === B);
  check('search results carry access fields', sb && sb.access_total === 5, JSON.stringify(sb ?? {}).slice(0, 160));

  if (VAULT) {
    // All three equally relevant and equally old; B is the one actually used.
    for (const p of [A, B, C]) await backdate(p, 200);
    const s2 = payload(await call('search_notes', { query: 'zebrafrequencyword' }));
    check('frequently-read old note ranks first', s2.results[0]?.path === B, s2.results.map((x) => `${x.path}:${x.score}`).join(' '));

    const st = payload(await call('list_notes', { directory: ROOT, sort: 'stale' }));
    // A was touched only by its write (mtime now backdated, access at write time) — C and B were read later.
    check('sort=stale puts least recently touched first', st.notes[0]?.path === A, st.notes.map((n) => n.path).join(','));
    const tb = payload(await call('list_notes', { directory: ROOT, touched_before: '30d' }));
    check('touched_before excludes recently accessed notes', tb.total_found === 0);
  } else {
    console.log('SKIP  ranking/stale checks (set VAULT_ROOT)');
  }

  // Move carries history.
  const D = `${ROOT}/moved/beta-renamed.md`;
  const mv = payload(await call('move_note', { from: B, to: D }));
  check('move_note ok', mv.to === D || mv.path === D || JSON.stringify(mv).includes('beta-renamed'), JSON.stringify(mv).slice(0, 120));
  const afterMove = payload(await call('list_notes', { directory: ROOT, sort: 'frequency', limit: 1 }));
  check('access history follows a move', afterMove.notes[0]?.path === D && afterMove.notes[0]?.access_total === 5, JSON.stringify(afterMove.notes[0]));

  // Soft delete then restore keeps history.
  const del = payload(await call('delete_note', { path: D }));
  if (del.trash_path) {
    await call('move_note', { from: del.trash_path, to: D });
    const restored = payload(await call('read_note', { path: D }));
    check('history survives trash + restore', restored.access?.access_total === 6, JSON.stringify(restored.access));
  }

  if (STATE) {
    await new Promise((res) => setTimeout(res, 2600)); // debounced flush
    try {
      const st = await stat(path.join(STATE, 'access.json'));
      const j = JSON.parse(await readFile(path.join(STATE, 'access.json'), 'utf8'));
      check('server persisted access.json (0600)', (st.mode & 0o777) === 0o600 && j.version === 1 && j.notes[D]?.reads >= 1);
      const text = JSON.stringify(j);
      check('access.json holds no note content', !text.includes('zebrafrequencyword'));
    } catch (err) {
      check('server persisted access.json', false, String(err));
    }
  }
} finally {
  try {
    await call('delete_note', { path: A });
    await call('delete_note', { path: C });
    await call('delete_note', { path: `${ROOT}/moved/beta-renamed.md` });
  } catch {}
  await client.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
