/**
 * delete_note / move_note verification for the Obsidian MCP server.
 *
 * These two tools mutate the vault, so they are tested against a live
 * authenticated endpoint rather than a stubbed one: origin JWT validation has no
 * localhost bypass, and the team-domain check deliberately refuses a fake local
 * issuer, so there is no way to exercise them without a real Access assertion.
 *
 * Everything happens inside a uniquely-named throwaway subtree which is removed
 * on the way out. If the vault is live-synced, that subtree will briefly
 * replicate to Obsidian Sync and then be deleted again.
 *
 * Usage:
 *   MCP_URL=https://mcp.example.com/mcp MCP_BEARER=<token> node test/tools-verify.mjs
 *
 * MCP_BEARER is an OAuth access token from the Cloudflare Access authorization
 * server. Alternatively set MCP_COOKIE to a CF_Authorization cookie value.
 */

const URL_ = process.env.MCP_URL;
const BEARER = process.env.MCP_BEARER;
const COOKIE = process.env.MCP_COOKIE;
const ACCESS_JWT = process.env.MCP_ACCESS_JWT; // local runs: the Cf-Access-Jwt-Assertion itself

if (!URL_ || (!BEARER && !COOKIE && !ACCESS_JWT)) {
  console.error('FATAL: set MCP_URL and one of MCP_BEARER / MCP_COOKIE / MCP_ACCESS_JWT to run these tests.');
  process.exit(78);
}

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function authHeaders() {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (BEARER) h.authorization = `Bearer ${BEARER}`;
  if (COOKIE) h.cookie = `CF_Authorization=${COOKIE}`;
  if (ACCESS_JWT) h['cf-access-jwt-assertion'] = ACCESS_JWT;
  return h;
}

let nextId = 1;

async function rpc(method, params) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  if (res.status !== 200) throw new Error(`${method} -> HTTP ${res.status}`);
  const body = await res.text();
  const line = body.split('\n').find((l) => l.startsWith('data: '));
  return line ? JSON.parse(line.slice(6)) : JSON.parse(body);
}

/** Call a tool. Returns { isError, text } and never throws on a tool-level error. */
async function call(name, args) {
  const d = await rpc('tools/call', { name, arguments: args });
  return { isError: d?.result?.isError === true, text: d?.result?.content?.[0]?.text ?? '' };
}

const json = (r) => {
  try {
    return JSON.parse(r.text);
  } catch {
    return {};
  }
};

async function main() {
  console.log(`\n=== delete_note / move_note verification: ${URL_} ===\n`);

  await rpc('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'tools-verify', version: '1.0.0' },
  });
  await rpc('notifications/initialized');

  const tools = (await rpc('tools/list'))?.result?.tools?.map((t) => t.name) ?? [];
  check('delete_note is advertised', tools.includes('delete_note'));
  check('move_note is advertised', tools.includes('move_note'));

  // Unique root so concurrent runs and leftovers can never collide.
  const ROOT = `_mcp_verify_${Date.now().toString(36)}`;
  const p = (rest) => `${ROOT}/${rest}`;

  try {
    // ---------------------------------------------------------------- fixtures
    await call('write_note', { path: p('raw/journal/day1.md'), content: '# Day 1\nalpha marker\n' });
    await call('write_note', { path: p('raw/journal/day2.md'), content: '# Day 2\nbeta marker\n' });
    await call('write_note', { path: p('rename-me.md'), content: '# Rename\n' });
    await call('write_note', { path: p('occupied.md'), content: 'ORIGINAL\n' });

    // ------------------------------------------------------------ move: rename
    {
      const r = await call('move_note', { from: p('rename-me.md'), to: p('renamed.md') });
      const old = await call('read_note', { path: p('rename-me.md') });
      const now = await call('read_note', { path: p('renamed.md') });
      check('rename a note in place', !r.isError && old.isError && !now.isError);
    }

    // -------------------------------------------- move: into a new parent dir
    {
      const r = await call('move_note', { from: p('renamed.md'), to: p('active/moved/renamed.md') });
      const now = await call('read_note', { path: p('active/moved/renamed.md') });
      check('move a note into a not-yet-existing folder', !r.isError && !now.isError);
    }

    // ------------------------------------------------- move: an entire folder
    {
      const r = await call('move_note', { from: p('raw/journal'), to: p('active/journal') });
      const kind = json(r).kind;
      const d1 = await call('read_note', { path: p('active/journal/day1.md') });
      const d2 = await call('read_note', { path: p('active/journal/day2.md') });
      const gone = await call('read_note', { path: p('raw/journal/day1.md') });
      check('move a whole folder with its notes', !r.isError && kind === 'directory' && !d1.isError && !d2.isError && gone.isError);
    }

    // ------------------------------------------------------ move: overwriting
    {
      const refused = await call('move_note', { from: p('active/moved/renamed.md'), to: p('occupied.md') });
      check('move refuses an existing destination by default', refused.isError);

      const forced = await call('move_note', { from: p('active/moved/renamed.md'), to: p('occupied.md'), overwrite: true });
      const body = await call('read_note', { path: p('occupied.md') });
      check('move overwrite=true replaces the destination', !forced.isError && !body.text.includes('ORIGINAL'));
    }

    // ------------------------------------------------------ delete: soft/trash
    let trashPath = null;
    {
      const r = await call('delete_note', { path: p('active/journal/day2.md') });
      const j = json(r);
      trashPath = j.trash_path;
      const gone = await call('read_note', { path: p('active/journal/day2.md') });
      const kept = await call('read_note', { path: j.trash_path ?? 'missing' });
      check('soft delete moves the note to .trash/', !r.isError && j.permanent === false && j.recoverable === true);
      check('soft delete removes the original path', gone.isError);
      check('soft delete preserves content in .trash/', kept.text.includes('beta marker'));
      check('trash path keeps the original layout', typeof trashPath === 'string' && trashPath.startsWith('.trash/') && trashPath.endsWith('day2.md'));
    }

    // ------------------------------------------------- trash is hidden, not listed
    {
      const listing = (json(await call('list_notes', { limit: 2000 })).notes ?? []).map((n) => n.path ?? n);
      check('trashed notes absent from list_notes', listing.filter((x) => x.startsWith('.trash/')).length === 0);

      const search = json(await call('search_notes', { query: 'beta marker', limit: 20 }));
      const fromTrash = (search.results ?? []).some((x) => x.path.startsWith('.trash/'));
      check('trashed notes absent from search_notes', !fromTrash);
    }

    // ----------------------------------------------------------- trash restore
    {
      const r = await call('move_note', { from: trashPath, to: p('active/journal/day2.md') });
      const back = await call('read_note', { path: p('active/journal/day2.md') });
      check('a trashed note can be restored with move_note', !r.isError && back.text.includes('beta marker'));
    }

    // -------------------------------------------------------- delete: permanent
    {
      const r = await call('delete_note', { path: p('active/journal/day2.md'), permanent: true });
      const j = json(r);
      const gone = await call('read_note', { path: p('active/journal/day2.md') });
      check('permanent delete erases the note', !r.isError && j.permanent === true && j.recoverable === false && gone.isError);
    }

    // ------------------------------------------------------------ sandbox cases
    const attacks = [
      ['delete: traversal',                'delete_note', { path: '../../etc/passwd' }],
      ['delete: absolute path',            'delete_note', { path: '/etc/hosts' }],
      ['delete: home-relative',            'delete_note', { path: '~/x.md' }],
      ['delete: .obsidian',                'delete_note', { path: '.obsidian/app.json' }],
      ['delete: .git',                     'delete_note', { path: '.git/config' }],
      ['delete: non-markdown',             'delete_note', { path: p('notes.txt') }],
      ['delete: a directory',              'delete_note', { path: p('active') }],
      ['delete: nonexistent note',         'delete_note', { path: p('nope.md') }],
      ['move: source outside vault',       'move_note',   { from: '../../etc/passwd', to: p('stolen.md') }],
      ['move: destination outside vault',  'move_note',   { from: p('occupied.md'), to: '../../tmp/exfil.md' }],
      ['move: absolute destination',       'move_note',   { from: p('occupied.md'), to: '/tmp/exfil.md' }],
      ['move: destination in .obsidian',   'move_note',   { from: p('occupied.md'), to: '.obsidian/evil.md' }],
      ['move: source in .git',             'move_note',   { from: '.git/config', to: p('config.md') }],
      ['move: note to non-markdown name',  'move_note',   { from: p('occupied.md'), to: p('occupied.sh') }],
      ['move: folder into itself',         'move_note',   { from: p('active'), to: p('active/nested') }],
      ['move: source equals destination',  'move_note',   { from: p('active'), to: p('active') }],
      ['move: nonexistent source',         'move_note',   { from: p('ghost.md'), to: p('x.md') }],
      ['move: onto an existing folder',    'move_note',   { from: p('active'), to: p('raw') }],
    ];

    for (const [label, tool, args] of attacks) {
      const r = await call(tool, args);
      check(`rejected -- ${label}`, r.isError, r.text.slice(0, 70));
    }
  } finally {
    // ------------------------------------------------------------- teardown
    const remaining = (json(await call('list_notes', { directory: ROOT, limit: 2000 })).notes ?? []).map((n) => n.path ?? n);
    for (const note of remaining) await call('delete_note', { path: note, permanent: true });

    const trashed = (json(await call('list_notes', { directory: '.trash', limit: 2000 })).notes ?? []).map((n) => n.path ?? n);
    for (const note of trashed.filter((x) => x.includes(ROOT))) {
      await call('delete_note', { path: note, permanent: true });
    }

    const after = (json(await call('list_notes', { limit: 2000 })).notes ?? []).map((n) => n.path ?? n);
    check('all test notes cleaned up', after.filter((x) => x.startsWith(`${ROOT}/`)).length === 0);
    console.log(
      `\n  note: empty directories under ${ROOT}/ and .trash/ may remain; the tool surface\n` +
        '  intentionally exposes no rmdir. Remove them on the host if it matters.'
    );
  }

  console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}\n`);
  process.exit(1);
});
