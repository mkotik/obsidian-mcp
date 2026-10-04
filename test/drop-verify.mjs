/**
 * Verification for direct chat-image upload: start_image_upload mints a
 * presigned, single-use /drop/<token> URL; Claude's code sandbox POSTs the
 * attached files there with curl; the server saves and embeds them.
 *
 *   MCP_URL=http://127.0.0.1:3999/mcp MCP_ACCESS_JWT=<jwt> VAULT_ROOT=<vault> node test/drop-verify.mjs
 *
 * DROP_BASE (default: the origin of MCP_URL) is where drop URLs are POSTed,
 * so the same suite runs against a local server or a staging copy.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import * as path from 'node:path';

const URL_MCP = process.env.MCP_URL ?? 'http://127.0.0.1:3999/mcp';
const DROP_BASE = (process.env.DROP_BASE ?? new URL(URL_MCP).origin).replace(/\/+$/, '');
const VAULT = process.env.VAULT_ROOT;
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
const local = (u) => DROP_BASE + new URL(u).pathname; // public URL -> the server under test
const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 60000 }, (err, stdout, stderr) => resolve({ err, out: String(stdout), errOut: String(stderr) })));
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
};

const client = new Client({ name: 'drop-verify', version: '1.3.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_MCP), { requestInit: { headers } }));
const call = (name, args) => client.callTool({ name, arguments: args });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(40)]);
const ROOT = `_mcp_drop_test_${Date.now().toString(36)}`;
const TMP = `/tmp/drop-verify-${process.pid}`;
await mkdir(TMP, { recursive: true });
await writeFile(`${TMP}/IMG_0001.png`, PNG);
await writeFile(`${TMP}/photo two.jpg`, JPEG);
await writeFile(`${TMP}/notes.txt`, 'not an image');
await writeFile(`${TMP}/a.heic`, HEIC);

try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('start_image_upload is listed', tools.includes('start_image_upload'));
  check('import_uploaded_images is gone', !tools.includes('import_uploaded_images'));
  check('15 tools in total', tools.length === 15, String(tools.length));

  // ---- minting
  const missing = await call('start_image_upload', { note_path: `${ROOT}/Nope.md` });
  check('missing note without create_note is refused', missing.isError === true && text(missing).includes('create_note'));
  const trav = await call('start_image_upload', { note_path: '../outside.md', create_note: true });
  check('note_path traversal is refused', trav.isError === true);
  const notMd = await call('start_image_upload', { note_path: `${ROOT}/x.txt`, create_note: true });
  check('non-markdown note_path is refused', notMd.isError === true);

  const note = `${ROOT}/Photos.md`;
  const s1 = payload(await call('start_image_upload', { note_path: note, create_note: true, width: 300 }));
  check('returns a /drop/ URL with a 32-char token', /\/drop\/[A-Za-z0-9_-]{32}$/.test(s1.url ?? ''), s1.url);
  check('returns a ready curl command for that URL', typeof s1.command === 'string' && s1.command.startsWith('curl ') && s1.command.includes(s1.url) && s1.command.includes('images=@'));
  check('URL is on the public hostname over https', (s1.url ?? '').startsWith('https://'));
  const mins = (Date.parse(s1.expires_at) - Date.now()) / 60000;
  check('expires in about 15 minutes', mins > 13 && mins <= 15.1, String(mins));
  const s2 = payload(await call('start_image_upload', { note_path: note, create_note: true }));
  check('each call mints a different token', s2.url && s2.url !== s1.url);

  // ---- what an unauthenticated caller can and cannot do
  const getRes = await fetch(local(s1.url));
  check('GET on a live drop URL reveals nothing (404)', getRes.status === 404);
  const bogus = await fetch(`${DROP_BASE}/drop/${'A'.repeat(32)}`, { method: 'POST', body: new FormData() });
  check('unknown token -> 404', bogus.status === 404);
  const shortTok = await fetch(`${DROP_BASE}/drop/abc`, { method: 'POST' });
  check('malformed token -> 404', shortTok.status === 404);
  const mcpNoAuth = await fetch(URL_MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('/mcp still requires Access (401 without JWT)', mcpNoAuth.status === 401);
  const link = payload(await call('create_upload_link', { note_path: note, create_note: true }));
  const linkTok = (link.url ?? '').split('/').pop();
  const crossFd = new FormData();
  crossFd.append('images', new Blob([PNG], { type: 'image/png' }), 'x.png');
  const cross = await fetch(`${DROP_BASE}/drop/${linkTok}`, { method: 'POST', body: crossFd });
  check('a browser /upload/ token does not work on /drop/', cross.status === 404);
  const upNoAuth = await fetch(`${DROP_BASE}/upload/${linkTok}`);
  check('/upload/ still requires Access (401 without JWT)', upNoAuth.status === 401);

  // ---- the real path: curl, exactly as Claude's sandbox runs it, no JWT
  const r1 = await run('curl', ['-sS', '--max-time', '60', '-F', `images=@${TMP}/IMG_0001.png`, '-F', `images=@${TMP}/photo two.jpg`, '-F', `images=@${TMP}/notes.txt`, local(s1.url)]);
  const o1 = parse(r1.out);
  check('curl upload succeeds without any credential', o1.ok === true, r1.out.slice(0, 300) + r1.errOut);
  check('two images saved', o1.images?.length === 2, JSON.stringify(o1.images));
  check('the text file is reported, not saved', o1.errors?.length === 1 && o1.errors[0].startsWith('notes.txt'));
  check('embedded into the newly created note', o1.embedded === true && o1.note_created === true && o1.note_path === note);
  check('embeds use the width chosen at mint time', o1.embeds?.length === 2 && o1.embeds.every((e) => e.endsWith('|300]]')));
  check('file names come from the uploaded files', o1.images?.some((i) => i.path.endsWith('IMG_0001.png')) && o1.images?.some((i) => i.path.endsWith('photo two.jpg')));
  if (VAULT && o1.images?.length) {
    const png = o1.images.find((i) => i.path.endsWith('.png'));
    const bytes = await readFile(path.join(VAULT, png.path));
    check('saved bytes are identical', Buffer.compare(bytes, PNG) === 0);
    const body = await readFile(path.join(VAULT, note), 'utf8');
    check('note contains both embeds', o1.embeds.every((e) => body.includes(e)));
  }
  const replay = await run('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-F', `images=@${TMP}/IMG_0001.png`, local(s1.url)]);
  check('token is single use (second POST -> 404)', replay.out === '404', replay.out);

  // ---- placement, filename override, folder
  await call('write_note', { path: `${ROOT}/Placed.md`, content: 'line one\nline two\n' });
  const s3 = payload(await call('start_image_upload', { note_path: `${ROOT}/Placed.md`, after_text: 'line one', filename: 'Whiteboard', folder: `${ROOT}/pics` }));
  const o3 = parse((await run('curl', ['-sS', '-F', `images=@${TMP}/IMG_0001.png`, local(s3.url)])).out);
  check('filename override is used', o3.images?.length === 1 && o3.images[0].path === `${ROOT}/pics/Whiteboard.png`, JSON.stringify(o3.images));
  if (VAULT) {
    const placed = await readFile(path.join(VAULT, `${ROOT}/Placed.md`), 'utf8');
    const lines = placed.split('\n');
    const i = lines.findIndex((l) => l.includes('line one'));
    check('embed placed after the matching line', lines[i + 1]?.includes('Whiteboard.png'), placed.slice(0, 200));
  }

  // ---- bad input still consumes the token
  const s4 = payload(await call('start_image_upload', {}));
  const r4 = await run('curl', ['-sS', '-w', '\n%{http_code}', '-F', `images=@${TMP}/a.heic`, local(s4.url)]);
  check('HEIC-only upload -> 400 with a conversion hint', r4.out.trim().endsWith('400') && r4.out.includes('HEIC'), r4.out.slice(0, 200));
  const r4b = await run('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-F', `images=@${TMP}/IMG_0001.png`, local(s4.url)]);
  check('a failed upload still burns the token', r4b.out === '404', r4b.out);
  const s5 = payload(await call('start_image_upload', {}));
  const r5 = await fetch(local(s5.url), { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
  check('non-multipart body -> 415', r5.status === 415);
  const s6 = payload(await call('start_image_upload', {}));
  const r6 = await run('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', local(s6.url), '-X', 'POST', '-H', 'content-type: multipart/form-data; boundary=x', '-H', `content-length: ${200 * 1024 * 1024}`, '--data-binary', '']);
  check('declared oversize body -> 413 (or refused)', ['413', '400', '000'].includes(r6.out), r6.out);
  const s7 = payload(await call('start_image_upload', {}));
  const o7 = parse((await run('curl', ['-sS', '-F', `images=@${TMP}/photo two.jpg`, local(s7.url)])).out);
  check('without a note: saved to attachments, not embedded', o7.ok === true && o7.embedded === false && o7.images?.[0]?.path?.startsWith('attachments/'), JSON.stringify(o7));

  const logText = await readFile(process.env.SERVER_LOG ?? '/tmp/server.log', 'utf8').catch(() => '');
  const toks = [s1, s2, s3, s4, s5, s6, s7].map((s) => (s.url ?? '').split('/').pop()).filter(Boolean);
  check('drop tokens never appear in the server log', logText.length > 0 && toks.every((t) => !logText.includes(t)));

  // cleanup
  if (o7.images?.[0]?.path) await call('delete_note', { path: o7.images[0].path }).catch(() => {});
  await call('move_note', { from: ROOT, to: `.trash/${ROOT}` }).catch(() => {});
} finally {
  await client.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
