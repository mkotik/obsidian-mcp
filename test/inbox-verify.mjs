/**
 * Verification for the GitHub inbox relay (start_image_upload /
 * import_uploaded_images) against an in-process fake of the GitHub REST API.
 *
 * The server must be started with:
 *   INBOX_REPO=test/vault-inbox INBOX_API_BASE=http://127.0.0.1:3998 INBOX_TOKEN_FILE=<file holding FAKE_TOKEN>
 *
 *   MCP_URL=http://127.0.0.1:3999/mcp MCP_ACCESS_JWT=<jwt> VAULT_ROOT=<vault> FAKE_TOKEN=<token> node test/inbox-verify.mjs
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const URL_MCP = process.env.MCP_URL ?? 'http://127.0.0.1:3999/mcp';
const VAULT = process.env.VAULT_ROOT;
const TOKEN = process.env.FAKE_TOKEN;
const headers = {};
if (process.env.MCP_ACCESS_JWT) headers['cf-access-jwt-assertion'] = process.env.MCP_ACCESS_JWT;

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
const text = (r) => r?.content?.[0]?.text ?? '';

// ---------------------------------------------------------------- fake GitHub
const sha = (b) => createHash('sha1').update(b).digest('hex');
const blobs = new Map();
const trees = new Map();
const commits = new Map();
let head = null;
let tokenOk = true;
const putBlob = (buf) => {
  const s = sha(Buffer.concat([Buffer.from('blob'), buf]));
  blobs.set(s, buf);
  return s;
};
const putTree = (entries) => {
  const s = sha(Buffer.from('tree' + JSON.stringify(entries) + Math.random()));
  trees.set(s, entries);
  return s;
};
const putCommit = (tree, parents) => {
  const s = sha(Buffer.from('commit' + tree + parents.join() + Math.random()));
  commits.set(s, { tree, parents });
  return s;
};
const currentEntries = () => trees.get(commits.get(head).tree);
function seed(files) {
  const entries = [...currentEntries()];
  for (const [p, buf] of Object.entries(files)) entries.push({ path: p, mode: '100644', type: 'blob', sha: putBlob(buf) });
  head = putCommit(putTree(entries), [head]);
}
head = putCommit(putTree([{ path: 'README.md', mode: '100644', type: 'blob', sha: putBlob(Buffer.from('# inbox\n')) }]), []);

const gh = createServer(async (req, res) => {
  const send = (code, obj, raw) => {
    res.writeHead(code, { 'content-type': raw ? 'application/octet-stream' : 'application/json' });
    res.end(raw ?? JSON.stringify(obj));
  };
  if (!tokenOk || req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  const prefix = '/repos/test/vault-inbox/';
  if (!p.startsWith(prefix)) return send(404, {});
  const rest = p.slice(prefix.length);
  let body = '';
  for await (const c of req) body += c;
  const json = body ? JSON.parse(body) : null;

  if (req.method === 'GET' && rest.startsWith('contents/')) {
    const target = rest.slice('contents/'.length);
    const entries = currentEntries();
    const file = entries.find((e) => e.path === target);
    if (file) {
      const buf = blobs.get(file.sha);
      if ((req.headers.accept ?? '').includes('raw')) return send(200, null, buf);
      return send(200, { type: 'file', path: file.path, size: buf.length });
    }
    const kids = entries.filter((e) => e.path.startsWith(target + '/') && !e.path.slice(target.length + 1).includes('/'));
    if (kids.length === 0) return send(404, { message: 'Not Found' });
    return send(200, kids.map((e) => ({ type: 'file', path: e.path, name: path.posix.basename(e.path), size: blobs.get(e.sha).length })));
  }
  if (req.method === 'GET' && rest === 'git/ref/heads/main') return send(200, { object: { sha: head } });
  if (req.method === 'GET' && rest.startsWith('git/commits/')) return send(200, { tree: { sha: commits.get(rest.slice(12)).tree } });
  if (req.method === 'GET' && rest.startsWith('git/trees/')) return send(200, { tree: trees.get(rest.slice(10)), truncated: false });
  if (req.method === 'POST' && rest === 'git/trees') {
    const entries = json.tree.map((e) => ({ path: e.path, mode: e.mode, type: 'blob', sha: e.sha ?? putBlob(Buffer.from(e.content)) }));
    return send(201, { sha: putTree(entries) });
  }
  if (req.method === 'POST' && rest === 'git/commits') return send(201, { sha: putCommit(json.tree, json.parents) });
  if (req.method === 'PATCH' && rest === 'git/refs/heads/main') {
    if (!json.force && !commits.get(json.sha).parents.includes(head)) return send(422, { message: 'not a fast forward' });
    head = json.sha;
    return send(200, { object: { sha: head } });
  }
  send(404, {});
});
await new Promise((r) => gh.listen(3998, '127.0.0.1', r));

// ---------------------------------------------------------------- tests
const client = new Client({ name: 'inbox-verify', version: '1.2.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_MCP), { requestInit: { headers } }));
const call = (name, args) => client.callTool({ name, arguments: args });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const ROOT = `_mcp_inbox_test_${Date.now().toString(36)}`;

try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('start_image_upload is listed', tools.includes('start_image_upload'));
  check('import_uploaded_images is listed', tools.includes('import_uploaded_images'));
  check('16 tools in total', tools.length === 16, String(tools.length));

  const start = payload(await call('start_image_upload', {}));
  const id = start.upload_id;
  check('upload_id has the expected shape', /^\d{8}T\d{6}Z-[a-z0-9]{6}$/.test(id ?? ''), id);
  check('script pushes into inbox/<id>', typeof start.script === 'string' && start.script.includes(`DEST='inbox/${id}'`));
  check('script carries the remote with the token', start.script.includes(`x-access-token:${TOKEN}@`) && start.script.includes('/test/vault-inbox.git'));
  check('script masks the token in errors', start.script.includes('x-access-token:***@'));
  await writeFile('/tmp/push-test.sh', start.script);
  let syntaxOk = true;
  try {
    execFileSync('bash', ['-n', '/tmp/push-test.sh']);
  } catch {
    syntaxOk = false;
  }
  check('script is valid bash', syntaxOk);
  let usage = '';
  try {
    execFileSync('bash', ['/tmp/push-test.sh'], { stdio: 'pipe' });
  } catch (e) {
    usage = String(e.stdout);
  }
  check('script without files prints usage', usage.includes('usage'));

  const id2 = payload(await call('start_image_upload', {})).upload_id;
  check('each call gets a new upload_id', id2 && id2 !== id);

  const empty = await call('import_uploaded_images', { upload_id: id });
  check('import before push is a clean error', empty.isError && text(empty).includes('nothing has been pushed'));
  const badId = await call('import_uploaded_images', { upload_id: '../../etc' });
  check('malformed upload_id is rejected', badId.isError && text(badId).includes('not valid'));
  const trav = await call('import_uploaded_images', { upload_id: id, note_path: '../outside.md' });
  check('note_path traversal is rejected', trav.isError === true);

  seed({
    [`inbox/${id}/IMG_0001.png`]: PNG,
    [`inbox/${id}/photo two.jpg`]: JPEG,
    [`inbox/${id}/notes.txt`]: Buffer.from('not an image'),
    [`inbox/${id2}/keep.png`]: PNG,
    'inbox/20200101T000000Z-aaaaaa/stale.png': PNG,
  });

  const note = `${ROOT}/Photos.md`;
  const r = await call('import_uploaded_images', { upload_id: id, note_path: note, create_note: true, width: 300 });
  const out = payload(r);
  check('import succeeds', !r.isError, text(r).slice(0, 200));
  check('two images saved', out.images?.length === 2, JSON.stringify(out.images));
  check('the text file is reported, not saved', out.errors?.length === 1 && out.errors[0].startsWith('notes.txt'));
  check('embedded into the new note', out.embedded === true && out.note_created === true);
  check('embeds use width', out.embeds?.every((e) => e.endsWith('|300]]')));
  check('names come from the pushed files', out.images?.some((i) => i.path.endsWith('IMG_0001.png')) && out.images?.some((i) => i.path.endsWith('photo two.jpg')));
  if (VAULT && out.images) {
    const png = out.images.find((i) => i.path.endsWith('.png'));
    const bytes = await readFile(path.join(VAULT, png.path));
    check('vault bytes match what was pushed', bytes.equals(PNG));
    const md = await readFile(path.join(VAULT, note), 'utf8');
    check('note contains both embeds', out.embeds.every((e) => md.includes(e)));
  }
  const paths = currentEntries().map((e) => e.path).sort();
  check('relay repo no longer holds the imported files', !paths.some((p) => p.startsWith(`inbox/${id}/`)), paths.join(','));
  check('stale upload was swept', !paths.some((p) => p.includes('20200101')));
  check('other pending upload was kept', paths.includes(`inbox/${id2}/keep.png`));
  check('README kept', paths.includes('README.md'));
  check('branch rewritten without history', commits.get(head).parents.length === 0);
  check('cleanup reported', /removed 4 file/.test(out.cleanup ?? ''), out.cleanup);

  const again = await call('import_uploaded_images', { upload_id: id });
  check('re-import of the same id is a clean error', again.isError && text(again).includes('nothing has been pushed'));

  // after_text placement into an existing note
  const id3 = payload(await call('start_image_upload', {})).upload_id;
  seed({ [`inbox/${id3}/x.png`]: PNG });
  await call('write_note', { path: `${ROOT}/Placed.md`, content: '# Title\nline one\nline two\n' });
  const placed = payload(await call('import_uploaded_images', { upload_id: id3, note_path: `${ROOT}/Placed.md`, after_text: 'line one', filename: 'Whiteboard' }));
  check('filename override is used', placed.images?.[0]?.path?.endsWith('Whiteboard.png'), JSON.stringify(placed.images));
  if (VAULT) {
    const md = await readFile(path.join(VAULT, `${ROOT}/Placed.md`), 'utf8');
    check('embed placed after the matching line', /line one\n!\[\[[^\]]*Whiteboard\.png\]\]\nline two/.test(md), md);
  }

  // only-bad upload: nothing saved, still cleaned
  const id4 = payload(await call('start_image_upload', {})).upload_id;
  seed({ [`inbox/${id4}/a.heic`]: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(40)]) });
  const heic = await call('import_uploaded_images', { upload_id: id4 });
  check('HEIC-only upload fails with a conversion hint', heic.isError && text(heic).includes('HEIC'), text(heic));
  check('HEIC upload was still removed from the relay', !currentEntries().some((e) => e.path.startsWith(`inbox/${id4}/`)));

  // expired / revoked token
  const id5 = payload(await call('start_image_upload', {})).upload_id;
  tokenOk = false;
  const denied = await call('import_uploaded_images', { upload_id: id5 });
  check('revoked token gives a clear error', denied.isError && text(denied).includes('may have expired'), text(denied));
  tokenOk = true;

  const log = await readFile(process.env.SERVER_LOG ?? '/tmp/server.log', 'utf8').catch(() => '');
  check('token never appears in the server log', log.length > 0 && !log.includes(TOKEN));

  await call('move_note', { from: ROOT, to: `.trash/${ROOT}` }).catch(() => {});
} finally {
  await client.close();
  gh.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
