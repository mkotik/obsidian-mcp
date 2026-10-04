/**
 * patch_note / get_backlinks / link-aware move_note verification.
 *
 * Runs against a live authenticated endpoint (origin JWT validation has no
 * localhost bypass), inside a uniquely-named throwaway subtree that is removed
 * on the way out.
 *
 * Usage:
 *   MCP_URL=https://mcp.example.com/mcp MCP_BEARER=<token> node test/edit-verify.mjs
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

let nextId = 1;

async function rpc(method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (BEARER) headers.authorization = `Bearer ${BEARER}`;
  if (COOKIE) headers.cookie = `CF_Authorization=${COOKIE}`;
  if (ACCESS_JWT) headers['cf-access-jwt-assertion'] = ACCESS_JWT;

  const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }) });
  if (res.status !== 200) throw new Error(`${method} -> HTTP ${res.status}`);
  const body = await res.text();
  const line = body.split('\n').find((l) => l.startsWith('data: '));
  return line ? JSON.parse(line.slice(6)) : JSON.parse(body);
}

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

// Compare note bodies only: the response also carries access counters that change on every read.
const read = async (p) => {
  const t = (await call('read_note', { path: p })).text;
  try {
    return JSON.parse(t).content ?? t;
  } catch {
    return t;
  }
};

async function main() {
  console.log(`\n=== patch_note / get_backlinks / link-aware move: ${URL_} ===\n`);

  await rpc('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'edit-verify', version: '1.0.0' } });
  await rpc('notifications/initialized');

  const tools = (await rpc('tools/list'))?.result?.tools?.map((t) => t.name) ?? [];
  check('patch_note is advertised', tools.includes('patch_note'));
  check('get_backlinks is advertised', tools.includes('get_backlinks'));

  const ROOT = `_mcp_edit_${Date.now().toString(36)}`;
  const p = (rest) => `${ROOT}/${rest}`;

  try {
    // =================================================== patch_note
    const BODY = '# Title\n\nalpha line\nbeta line\nalpha line\n\ntail\n';
    await call('write_note', { stamp_dates: false, path: p('patch/doc.md'), content: BODY });

    {
      const r = await call('patch_note', { path: p('patch/doc.md'), old_text: 'beta line', new_text: 'BETA LINE' });
      const body = await read(p('patch/doc.md'));
      check('patch replaces a unique anchor', !r.isError && json(r).replacements === 1 && body.includes('BETA LINE'));
      check('patch leaves the rest of the note intact', body.includes('# Title') && body.includes('tail') && body.includes('alpha line'));
    }

    {
      const beforeBody = await read(p('patch/doc.md'));
      const r = await call('patch_note', { path: p('patch/doc.md'), old_text: 'nowhere to be found', new_text: 'x' });
      const afterBody = await read(p('patch/doc.md'));
      check('missing anchor is refused', r.isError);
      check('note is byte-identical after a refused patch', beforeBody === afterBody);
    }

    {
      const beforeBody = await read(p('patch/doc.md'));
      const r = await call('patch_note', { path: p('patch/doc.md'), old_text: 'alpha line', new_text: 'x' });
      const afterBody = await read(p('patch/doc.md'));
      check('ambiguous anchor is refused by default', r.isError && r.text.includes('2'), r.text.slice(0, 90));
      check('note unchanged after ambiguous refusal', beforeBody === afterBody);
    }

    {
      const r = await call('patch_note', { path: p('patch/doc.md'), old_text: 'alpha line', new_text: 'ALPHA', expected_matches: 2 });
      const body = await read(p('patch/doc.md'));
      check('expected_matches=2 replaces both', !r.isError && json(r).replacements === 2 && !body.includes('alpha line'));
    }

    {
      const r = await call('patch_note', { path: p('patch/doc.md'), old_text: 'expected_matches mismatch', new_text: 'x', expected_matches: 3 });
      check('wrong expected_matches is refused', r.isError);
    }

    {
      await call('write_note', { stamp_dates: false, path: p('patch/del.md'), content: 'keep\nDELETE ME\nkeep2\n' });
      const r = await call('patch_note', { path: p('patch/del.md'), old_text: 'DELETE ME\n', new_text: '' });
      const body = await read(p('patch/del.md'));
      check('empty new_text deletes the anchor', !r.isError && !body.includes('DELETE ME') && body.includes('keep2'));
    }

    for (const [label, args] of [
      ['nonexistent note', { path: p('patch/ghost.md'), old_text: 'a', new_text: 'b' }],
      ['traversal path', { path: '../../etc/passwd', old_text: 'root', new_text: 'x' }],
      ['absolute path', { path: '/etc/hosts', old_text: 'localhost', new_text: 'x' }],
      ['non-markdown', { path: p('patch/x.txt'), old_text: 'a', new_text: 'b' }],
      ['.obsidian', { path: '.obsidian/app.json', old_text: '{', new_text: 'x' }],
      ['a directory', { path: p('patch'), old_text: 'a', new_text: 'b' }],
    ]) {
      const r = await call('patch_note', args);
      check(`patch rejected -- ${label}`, r.isError, r.text.slice(0, 60));
    }

    // =================================================== get_backlinks
    await call('write_note', { stamp_dates: false, path: p('links/Target Note.md'), content: '# Target\n\nbody\n' });
    await call('write_note', { stamp_dates: false, path: p('links/bare.md'), content: `refs [[Target Note]] here\n` });
    await call('write_note', { stamp_dates: false, path: p('links/pathform.md'), content: `refs [[${ROOT}/links/Target Note]] here\n` });
    await call('write_note', { stamp_dates: false, path: p('links/embed.md'), content: `embed ![[Target Note]]\n` });
    await call('write_note', { stamp_dates: false, path: p('links/alias.md'), content: `alias [[Target Note|Shown]]\n` });
    await call('write_note', { stamp_dates: false, path: p('links/none.md'), content: 'no links at all\n' });

    {
      const r = await call('get_backlinks', { path: p('links/Target Note.md'), limit: 50 });
      const d = json(r);
      const paths = (d.results ?? []).map((x) => x.path);
      check('backlinks finds bare link', paths.includes(p('links/bare.md')), JSON.stringify(paths));
      check('backlinks finds path-form link', paths.includes(p('links/pathform.md')));
      check('backlinks finds embed', paths.includes(p('links/embed.md')));
      check('backlinks finds aliased link', paths.includes(p('links/alias.md')));
      check('backlinks excludes non-linking note', !paths.includes(p('links/none.md')));
      check('backlinks excludes the target itself', !paths.includes(p('links/Target Note.md')));
      const bare = (d.results ?? []).find((x) => x.path === p('links/bare.md'));
      check('backlinks reports line number and link text', bare?.matches?.[0]?.line === 1 && bare?.matches?.[0]?.link === '[[Target Note]]', JSON.stringify(bare?.matches?.[0]));
    }

    // =================================================== link-aware rename
    {
      const r = await call('move_note', { from: p('links/Target Note.md'), to: p('links/Renamed Note.md') });
      const d = json(r);
      const bare = await read(p('links/bare.md'));
      const embed = await read(p('links/embed.md'));
      const alias = await read(p('links/alias.md'));
      const pathform = await read(p('links/pathform.md'));

      check('rename rewrites bare links', bare.includes('[[Renamed Note]]'), bare.trim());
      check('rename preserves embed prefix', embed.includes('![[Renamed Note]]'), embed.trim());
      check('rename preserves alias', alias.includes('[[Renamed Note|Shown]]'), alias.trim());
      check('rename updates path-form link', pathform.includes(`[[${ROOT}/links/Renamed Note]]`), pathform.trim());
      check('move reports how many notes it edited', d.links_updated?.notes_edited === 4, JSON.stringify(d.links_updated?.notes_edited));
      check('move reports per-file details', Array.isArray(d.links_updated?.details) && d.links_updated.details.length === 4);
      const untouched = (d.links_updated?.details ?? []).every((x) => x.path !== p('links/none.md'));
      check('note with no links was left alone', untouched && (await read(p('links/none.md'))).includes('no links at all'));
    }

    // =================================================== folder move
    {
      await call('write_note', { stamp_dates: false, path: p('folder/journal/Entry One.md'), content: '# Entry One\n' });
      await call('write_note', { stamp_dates: false, path: p('folder/ref.md'), content: `bare [[Entry One]] and path [[${ROOT}/folder/journal/Entry One]]\n` });

      const r = await call('move_note', { from: p('folder/journal'), to: p('folder/active') });
      const d = json(r);
      const ref = await read(p('folder/ref.md'));

      check('folder move succeeds', !r.isError && d.kind === 'directory');
      check('folder move leaves bare link untouched (still resolves)', ref.includes('[[Entry One]]'), ref.trim());
      check('folder move fixes path-form link', ref.includes(`[[${ROOT}/folder/active/Entry One]]`), ref.trim());
      check('moved note is readable at its new path', !(await call('read_note', { path: p('folder/active/Entry One.md') })).isError);
    }

    // =================================================== opt out
    {
      await call('write_note', { stamp_dates: false, path: p('optout/Keep Name.md'), content: '# Keep\n' });
      await call('write_note', { stamp_dates: false, path: p('optout/ref.md'), content: 'see [[Keep Name]]\n' });

      const r = await call('move_note', { from: p('optout/Keep Name.md'), to: p('optout/New Name.md'), update_links: false });
      const ref = await read(p('optout/ref.md'));
      check('update_links=false skips rewriting', !r.isError && json(r).links_updated?.enabled === false && ref.includes('[[Keep Name]]'), ref.trim());
    }
  } finally {
    const remaining = (json(await call('list_notes', { directory: ROOT, limit: 2000 })).notes ?? []).map((n) => n.path ?? n);
    for (const note of remaining) await call('delete_note', { path: note, permanent: true });

    const trashed = (json(await call('list_notes', { directory: '.trash', limit: 2000 })).notes ?? []).map((n) => n.path ?? n);
    for (const note of trashed.filter((x) => x.includes(ROOT))) await call('delete_note', { path: note, permanent: true });

    const after = (json(await call('list_notes', { limit: 3000 })).notes ?? []).map((n) => n.path ?? n);
    check('all test notes cleaned up', after.filter((x) => x.startsWith(`${ROOT}/`)).length === 0);
  }

  console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}\n`);
  process.exit(1);
});
