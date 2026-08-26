/**
 * Real MCP client verification against the local Streamable HTTP endpoint.
 * Performs a genuine MCP handshake and exercises all five tools plus the
 * path-sandbox rejection cases. Exits non-zero if any check fails.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { symlink, rm, access } from 'node:fs/promises';

const URL_MCP = process.env.MCP_URL ?? 'http://127.0.0.1:3000/mcp';
const VAULT = process.env.VAULT_ROOT ?? '/home/ubuntu/vaults/main';
const TEST_NOTE = '_mcp_test/verification.md';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Parse the JSON payload our tools return as their text content block. */
function payload(result) {
  const text = result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function isErr(result) {
  return result?.isError === true;
}

const client = new Client({ name: 'mcp-verify', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(URL_MCP));

async function call(name, args) {
  return client.callTool({ name, arguments: args });
}

async function main() {
  // ---------------------------------------------------------------- handshake
  await client.connect(transport);
  const info = client.getServerVersion?.() ?? {};
  check('MCP handshake completed', true, `server=${info.name ?? '?'} v${info.version ?? '?'}`);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = ['append_note', 'list_notes', 'read_note', 'search_notes', 'write_note'];
  check('exactly the 5 expected tools exposed', JSON.stringify(names) === JSON.stringify(expected), names.join(','));

  // ------------------------------------------------------------- read tests
  const listed = payload(await call('list_notes', { limit: 500 }));
  const existing = (listed.notes ?? []).filter((p) => !p.startsWith('_mcp_test/'));
  check('list_notes returned existing notes', existing.length > 0, `${listed.total_found} notes found`);
  check('list_notes returns only .md paths', existing.every((p) => p.endsWith('.md')));
  check('list_notes returns no absolute paths', existing.every((p) => !p.startsWith('/')));
  check(
    'list_notes excludes .obsidian and .git',
    existing.every((p) => !p.split('/').includes('.obsidian') && !p.split('/').includes('.git'))
  );

  const sample = existing[0];
  const readExisting = payload(await call('read_note', { path: sample }));
  check('read_note read an existing note unmodified', typeof readExisting.content === 'string' && readExisting.bytes > 0,
    `${sample} (${readExisting.bytes} bytes)`);

  // ------------------------------------------------------------ search test
  const searchTerm = 'the';
  const searchExisting = payload(await call('search_notes', { query: searchTerm, limit: 5 }));
  check('search_notes found matches in existing vault', (searchExisting.results ?? []).length > 0,
    `${searchExisting.result_count} notes matched "${searchTerm}"`);
  check('search_notes returned snippets', (searchExisting.results?.[0]?.snippets ?? []).length > 0);

  // ------------------------------------------------------------- write test
  const wrote = payload(await call('write_note', { path: TEST_NOTE, content: '# MCP Verification\n\nwrite-test-ok\n' }));
  check('write_note created the test note', wrote.path === TEST_NOTE, `${wrote.bytes_written} bytes`);

  const afterWrite = payload(await call('read_note', { path: TEST_NOTE }));
  check('read_note sees write-test-ok', (afterWrite.content ?? '').includes('write-test-ok'));

  // ------------------------------------------------------------ append test
  const appended = payload(await call('append_note', { path: TEST_NOTE, content: '\nappend-test-ok\n' }));
  check('append_note appended to the note', appended.path === TEST_NOTE, `${appended.bytes_appended} bytes`);

  const afterAppend = payload(await call('read_note', { path: TEST_NOTE }));
  check('both write-test-ok and append-test-ok present',
    (afterAppend.content ?? '').includes('write-test-ok') && (afterAppend.content ?? '').includes('append-test-ok'));

  // ------------------------------------------------------------ listing test
  const relisted = payload(await call('list_notes', { limit: 2000 }));
  check('list_notes finds _mcp_test/verification.md', (relisted.notes ?? []).includes(TEST_NOTE));

  // ------------------------------------------------- search the new content
  const searchNew = payload(await call('search_notes', { query: 'append-test-ok' }));
  check('search_notes finds append-test-ok',
    (searchNew.results ?? []).some((r) => r.path === TEST_NOTE));

  // ------------------------------------------------------------ sandbox tests
  console.log('\n--- sandbox / traversal rejection tests ---');
  const traversals = [
    '../etc/passwd',
    '../../etc/passwd',
    '../../../../etc/passwd',
    '/etc/passwd',
    '/home/ubuntu/.bashrc',
    '~/secret.md',
    '../main/../../vaults/main/../../etc/passwd',
    '.obsidian/app.json',
    'notes/../../etc/passwd',
  ];
  for (const p of traversals) {
    const r = await call('read_note', { path: p });
    check(`read_note rejects ${p}`, isErr(r), payload(r)._raw ?? '');
  }

  for (const p of ['../evil.md', '/tmp/evil.md', '../../home/ubuntu/evil.md']) {
    const r = await call('write_note', { path: p, content: 'nope' });
    check(`write_note rejects ${p}`, isErr(r));
  }

  // non-markdown write must fail
  const shWrite = await call('write_note', { path: '_mcp_test/test.sh', content: '#!/bin/sh\necho hi\n' });
  check('write_note rejects non-markdown _mcp_test/test.sh', isErr(shWrite));
  let shExists = false;
  try {
    await access(`${VAULT}/_mcp_test/test.sh`);
    shExists = true;
  } catch {}
  check('_mcp_test/test.sh was not created on disk', !shExists);

  const shAppend = await call('append_note', { path: '_mcp_test/test.sh', content: 'x', create_if_missing: true });
  check('append_note rejects non-markdown path', isErr(shAppend));

  // append to a nonexistent note without create_if_missing must fail
  const missingAppend = await call('append_note', { path: '_mcp_test/does-not-exist.md', content: 'x' });
  check('append_note rejects missing note without create_if_missing', isErr(missingAppend));

  // ------------------------------------------------------- symlink escape test
  const linkRel = '_mcp_test/escape.md';
  const linkAbs = `${VAULT}/${linkRel}`;
  await rm(linkAbs, { force: true });
  await symlink('/etc/passwd', linkAbs);
  try {
    const linkRead = await call('read_note', { path: linkRel });
    check('read_note rejects symlink escaping to /etc/passwd', isErr(linkRead), payload(linkRead)._raw ?? '');
    const linkWrite = await call('write_note', { path: linkRel, content: 'pwned' });
    check('write_note rejects symlink escaping the vault', isErr(linkWrite));
    const linkList = payload(await call('list_notes', { limit: 2000 }));
    check('list_notes does not follow the escape symlink', !(linkList.notes ?? []).includes(linkRel));
  } finally {
    await rm(linkAbs, { force: true });
  }
  let linkGone = false;
  try {
    await access(linkAbs);
  } catch {
    linkGone = true;
  }
  check('escape symlink removed after test', linkGone);

  await client.close();

  console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL', err?.stack ?? err);
  process.exitCode = 1;
});
