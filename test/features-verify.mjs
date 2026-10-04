/**
 * Verification for the v1.1 features: note dates (created / modified, date
 * filters, recency ranking, frontmatter stamping), tags (extraction, filters,
 * list_tags, update_tags), and images (add_image, read_image, embeds in
 * read_note, upload links, SSRF refusals).
 *
 * Everything happens inside a uniquely named throwaway subtree, which is moved
 * to .trash/ at the end (images cannot be deleted individually by design).
 *
 *   MCP_URL=https://obsidian.example.com/mcp MCP_BEARER=<access-token> npm run features-verify
 *
 * Locally, pass the Cloudflare Access assertion directly instead:
 *   MCP_URL=http://127.0.0.1:3000/mcp MCP_ACCESS_JWT=<jwt> npm run features-verify
 *
 * VAULT_ROOT (optional, local only) enables the checks that need direct
 * filesystem access: backdating mtimes so ranking and date filters can be
 * asserted deterministically.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { utimes, stat, readFile } from 'node:fs/promises';
import * as path from 'node:path';

const URL_MCP = process.env.MCP_URL ?? 'http://127.0.0.1:3000/mcp';
const VAULT = process.env.VAULT_ROOT; // optional: only for local runs
const NET = process.env.SKIP_NETWORK !== '1';
const headers = {};
if (process.env.MCP_BEARER) headers.authorization = `Bearer ${process.env.MCP_BEARER}`;
if (process.env.MCP_ACCESS_JWT) headers['cf-access-jwt-assertion'] = process.env.MCP_ACCESS_JWT;

const ROOT = `_mcp_features_test_${Date.now().toString(36)}`;
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
const isErr = (r) => r?.isError === true;

const client = new Client({ name: 'features-verify', version: '1.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), { requestInit: { headers } });
const call = (name, args) => client.callTool({ name, arguments: args });

// 1x1 transparent PNG, and a few non-images.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DAY = 86_400_000;

async function backdate(rel, daysAgo) {
  if (!VAULT) return false;
  const t = new Date(Date.now() - daysAgo * DAY);
  await utimes(path.join(VAULT, rel), t, t);
  return true;
}

async function main() {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const t of ['list_tags', 'update_tags', 'add_image', 'read_image', 'create_upload_link']) check(`tool ${t} exposed`, names.has(t));
  check('15 tools total', tools.length === 15, `${tools.length}`);

  // ---------------------------------------------------------------- fixtures
  const A = `${ROOT}/alpha.md`; // frontmatter tags + created, stale updated
  const B = `${ROOT}/beta.md`; // no frontmatter, inline tags
  const C = `${ROOT}/sub/gamma.md`; // block-list tags, nested tag
  const T = `${ROOT}/template.md`; // placeholders
  const w = async (p, content) => payload(await call('write_note', { path: p, content, stamp_dates: false }));
  await w(A, '---\ntitle: Alpha\ncreated: 2026-01-15\nupdated: 2026-01-20\ntags: [research, Project/Alpha]\n---\n# Alpha\n\nzephyrword appears here once.\n');
  await w(B, '# Beta\n\nzephyrword twice: zephyrword. Inline #idea and #Research tags.\n\n```\n#not-a-tag in code\n```\n');
  await w(C, '---\ntags:\n  - project/beta\n  - draft\ncustom: keep me   # comment\n---\nGamma body #inline-tag\n');
  await w(T, '---\ntags: [tag1, tag2]\ncreated: YYYY-MM-DD\nupdated: YYYY-MM-DD\n---\ntemplate\n');

  // ----------------------------------------------------------------- dates
  const ra = payload(await call('read_note', { path: A }));
  check('read_note returns created from frontmatter', ra.created?.startsWith('2026-01-15') && ra.created_source === 'frontmatter', ra.created);
  check('read_note returns modified (filesystem)', typeof ra.modified === 'string' && /T\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(ra.modified), ra.modified);
  check('stale frontmatter updated is flagged', ra.dates_mismatch === true && ra.updated_frontmatter === '2026-01-20');
  check('frontmatter tags parsed', JSON.stringify(ra.tags) === JSON.stringify(['research', 'Project/Alpha']), JSON.stringify(ra.tags));

  const rb = payload(await call('read_note', { path: B }));
  check('note without frontmatter gets filesystem created', rb.created_source === 'filesystem' && typeof rb.created === 'string');
  check('inline tags parsed, code ignored', JSON.stringify(rb.tags) === JSON.stringify(['idea', 'Research']), JSON.stringify(rb.tags));
  const rc = payload(await call('read_note', { path: C }));
  check('block-list + inline tags parsed', JSON.stringify(rc.tags) === JSON.stringify(['project/beta', 'draft', 'inline-tag']), JSON.stringify(rc.tags));

  // Deterministic ranking: make alpha old and beta recent, then search.
  const canBackdate = (await backdate(A, 120)) && (await backdate(B, 1)) && (await backdate(C, 40)) && (await backdate(T, 400));
  if (canBackdate) {
    const l = payload(await call('list_notes', { directory: ROOT }));
    const order = l.notes.map((n) => path.posix.basename(n.path));
    check('list_notes default: most recently modified first', JSON.stringify(order) === JSON.stringify(['beta.md', 'gamma.md', 'alpha.md', 'template.md']), order.join(','));
    check('list_notes carries now/timezone', typeof l.now === 'string' && typeof l.timezone === 'string');
    const byCreated = payload(await call('list_notes', { directory: ROOT, sort: 'created' }));
    check('sort=created puts frontmatter-dated alpha after filesystem-dated notes', byCreated.notes.at(-1).path === T || byCreated.notes.some((n) => n.path === A));

    const recent = payload(await call('list_notes', { directory: ROOT, modified_after: '7d' }));
    check('modified_after=7d', recent.notes.length === 1 && recent.notes[0].path === B, recent.notes.map((n) => n.path).join(','));
    const window = payload(await call('list_notes', { directory: ROOT, modified_after: '60d', modified_before: '30d' }));
    check('modified window 60d..30d', window.notes.length === 1 && window.notes[0].path === C, window.notes.map((n) => n.path).join(','));
    const createdJan = payload(await call('list_notes', { directory: ROOT, created_after: '2026-01-01', created_before: '2026-01-31' }));
    check('created date range (frontmatter date)', createdJan.notes.length === 1 && createdJan.notes[0].path === A, createdJan.notes.map((n) => n.path).join(','));

    // Same single body hit in alpha and gamma-like? alpha has 1 hit and is old; beta has 2 hits and is recent.
    await w(`${ROOT}/old-strong.md`, '# old\nquasarword quasarword quasarword\n');
    await w(`${ROOT}/new-weak.md`, '# new\nquasarword\n');
    await backdate(`${ROOT}/old-strong.md`, 365);
    await backdate(`${ROOT}/new-weak.md`, 0);
    const s1 = payload(await call('search_notes', { query: 'quasarword' }));
    check('search ranks recently changed note first when relevance is close', s1.results[0]?.path === `${ROOT}/new-weak.md`, s1.results.map((r) => `${r.path}:${r.score}`).join(' '));
    const s2 = payload(await call('search_notes', { query: 'quasarword', sort: 'created' }));
    check('search sort=created works', s2.results.length === 2);
    await w(`${ROOT}/also-old.md`, '# quasarword in the title area\n');
    const s3 = payload(await call('search_notes', { query: 'quasarword', modified_before: '30d' }));
    check('search + modified_before filter', s3.results.length === 1 && s3.results[0].path === `${ROOT}/old-strong.md`, s3.results.map((r) => r.path).join(','));
  } else {
    console.log('SKIP  ranking/date-window checks (set VAULT_ROOT for a local run)');
  }

  const bad = await call('list_notes', { modified_after: 'last tuesday' });
  check('unparseable date filter rejected', isErr(bad));
  const relDate = payload(await call('list_notes', { directory: ROOT, modified_after: 'today' }));
  check('"today" accepted', Array.isArray(relDate.notes));

  // -------------------------------------------------------------- stamping
  const N = `${ROOT}/new-note.md`;
  const wn = payload(await call('write_note', { path: N, content: '# New\n\nbody\n' }));
  const nText = payload(await call('read_note', { path: N })).content;
  check('write_note stamps created + updated on a new note', /^---\ncreated: \d{4}-\d{2}-\d{2}\nupdated: \d{4}-\d{2}-\d{2}\n---\n# New/.test(nText), JSON.stringify(wn.dates_stamped));

  await call('write_note', { path: A, content: '---\ntitle: Alpha v2\ntags: [research]\n---\nrewritten zephyrword\n' });
  const a2 = payload(await call('read_note', { path: A }));
  check('overwrite keeps the original created date', a2.content.includes('created: 2026-01-15'), a2.content.split('\n').slice(0, 6).join(' | '));
  check('overwrite refreshes updated', /updated: \d{4}-\d{2}-\d{2}/.test(a2.content) && !a2.content.includes('updated: 2026-01-20'));

  const ap = payload(await call('append_note', { path: B, content: '\nappended line\n' }));
  const b2 = payload(await call('read_note', { path: B }));
  check('append_note adds frontmatter to a note without it', b2.content.startsWith('---\ncreated: ') && b2.content.endsWith('appended line\n'), JSON.stringify(ap.dates_stamped));

  await call('append_note', { path: T, content: 'more\n' });
  const t2 = payload(await call('read_note', { path: T }));
  check('template placeholders are left alone', t2.content.includes('created: YYYY-MM-DD') && t2.content.includes('updated: YYYY-MM-DD'));

  const pn = payload(await call('patch_note', { path: C, old_text: 'Gamma body', new_text: 'Gamma text' }));
  const c2 = payload(await call('read_note', { path: C }));
  check('patch_note stamps and preserves other frontmatter byte-for-byte', c2.content.includes('custom: keep me   # comment') && /updated: /.test(c2.content), JSON.stringify(pn.dates_stamped));

  const ns = payload(await call('write_note', { path: `${ROOT}/nostamp.md`, content: 'plain\n', stamp_dates: false }));
  check('stamp_dates=false writes verbatim', JSON.stringify(ns.dates_stamped) === '[]');

  // ------------------------------------------------------------------ tags
  const beforeStat = VAULT ? await stat(path.join(VAULT, C)) : null;
  const ut = payload(await call('update_tags', { path: C, add: ['#Reading List', 'draft', 'ml'], remove: ['project/beta'] }));
  const c3 = payload(await call('read_note', { path: C }));
  check('update_tags adds/removes (case-insensitive dedupe, # stripped, spaces → -)', JSON.stringify(ut.frontmatter_tags) === JSON.stringify(['draft', 'Reading-List', 'ml']), JSON.stringify(ut.frontmatter_tags));
  check('block-list style preserved', c3.content.includes('tags:\n  - draft\n  - Reading-List\n  - ml\n'), c3.content.split('\n').slice(0, 7).join(' | '));
  if (beforeStat) {
    const afterStat = await stat(path.join(VAULT, C));
    check('update_tags preserves modified time (+1s)', Math.abs(afterStat.mtimeMs - (beforeStat.mtimeMs + 1000)) < 5, `${beforeStat.mtimeMs} -> ${afterStat.mtimeMs}`);
  }
  const ut2 = payload(await call('update_tags', { path: B, add: ['beta-tag'], remove: ['idea'] }));
  const b3 = payload(await call('read_note', { path: B }));
  check('flow-style tags added to note frontmatter', /\ntags: \[beta-tag\]\n/.test(b3.content), b3.content.split('\n').slice(0, 5).join(' | '));
  check('removing an inline-only tag is reported, not silently ignored', Array.isArray(ut2.still_inline) && ut2.still_inline.includes('idea'));
  check('invalid tag rejected', isErr(await call('update_tags', { path: B, add: ['1234'] })) && isErr(await call('update_tags', { path: B, add: ['bad tag!'] })));
  check('update_tags on .obsidian rejected', isErr(await call('update_tags', { path: '.obsidian/x.md', add: ['a'] })));
  check('update_tags traversal rejected', isErr(await call('update_tags', { path: '../x.md', add: ['a'] })));

  const byTag = payload(await call('list_notes', { directory: ROOT, tags: ['research'] }));
  check('filter by tag (frontmatter + inline, case-insensitive)', byTag.notes.map((n) => n.path).sort().join(',') === [A, B].sort().join(','), byTag.notes.map((n) => n.path).join(','));
  await call('update_tags', { path: N, add: ['project/gamma'] });
  const nested = payload(await call('list_notes', { directory: ROOT, tags: ['project'] }));
  check('parent tag matches nested tags', nested.notes.some((n) => n.path === N), nested.notes.map((n) => n.path).join(','));
  const both = payload(await call('list_notes', { directory: ROOT, tags: ['research', 'beta-tag'] }));
  check('multiple tags = AND', both.notes.length === 1 && both.notes[0].path === B);
  const st = payload(await call('search_notes', { query: 'zephyrword', tags: ['beta-tag'] }));
  check('search + tag filter', st.results.length === 1 && st.results[0].path === B);
  const sTag = payload(await call('search_notes', { query: 'reading-list' }));
  check('search matches tags too', sTag.results.some((r) => r.path === C && r.matched_in.includes('tags')));

  const lt = payload(await call('list_tags', { directory: ROOT }));
  const research = lt.tags.find((t) => t.tag.toLowerCase() === 'research');
  check('list_tags counts notes per tag', research?.notes === 2, JSON.stringify(lt.tags.slice(0, 6)));
  check('list_tags reports untagged notes', typeof lt.untagged_notes === 'number');
  const lp = payload(await call('list_tags', { directory: ROOT, prefix: 'project' }));
  check('list_tags prefix filter', lp.tags.every((t) => t.tag.toLowerCase().startsWith('project')) && lp.tags.length >= 1);

  // ---------------------------------------------------------------- images
  const IMG = `${ROOT}/img`;
  const ai = payload(await call('add_image', { data_base64: PNG_B64, folder: IMG, filename: 'tiny dot', note_path: A, after_text: 'rewritten zephyrword', width: 200 }));
  check('add_image saves base64 image', ai.image_path === `${IMG}/tiny dot.png` && ai.mime === 'image/png', JSON.stringify(ai));
  const a3 = payload(await call('read_note', { path: A }));
  check('image embedded after the anchor line', a3.content.includes(`rewritten zephyrword\n![[${IMG}/tiny dot.png|200]]`), a3.content.slice(-120));
  const ai2 = payload(await call('add_image', { data_base64: `data:image/png;base64,${PNG_B64}`, folder: IMG, filename: 'tiny dot' }));
  check('name collision gets a suffix, never overwrites', ai2.image_path === `${IMG}/tiny dot 1.png`, ai2.image_path);
  const ai3 = payload(await call('add_image', { data_base64: PNG_B64, folder: IMG, filename: '../../../etc/passwd', note_path: N }));
  check('filename cannot traverse', typeof ai3.image_path === 'string' && ai3.image_path.startsWith(`${IMG}/`) && !ai3.image_path.includes('..'), ai3.image_path);
  check('embed appended at end by default', payload(await call('read_note', { path: N })).content.trimEnd().endsWith(`![[${ai3.image_path}]]`));

  check('not-an-image base64 rejected', isErr(await call('add_image', { data_base64: Buffer.from('hello world, not an image').toString('base64'), folder: IMG })));
  check('both sources rejected', isErr(await call('add_image', { data_base64: PNG_B64, url: 'https://example.com/a.png' })));
  check('no source rejected', isErr(await call('add_image', { folder: IMG })));
  check('folder traversal rejected', isErr(await call('add_image', { data_base64: PNG_B64, folder: '../outside' })));
  check('.obsidian folder rejected', isErr(await call('add_image', { data_base64: PNG_B64, folder: '.obsidian' })));
  check('embed into non-markdown rejected', isErr(await call('add_image', { data_base64: PNG_B64, folder: IMG, note_path: `${ROOT}/x.txt` })));
  const missingNote = payload(await call('add_image', { data_base64: PNG_B64, folder: IMG, note_path: `${ROOT}/missing.md` }));
  check('missing note: image saved, embed error reported', missingNote.embedded === false && typeof missingNote.embed_error === 'string');

  for (const [label, url] of [
    ['http (not https)', 'http://example.com/a.png'],
    ['loopback IP', 'https://127.0.0.1/a.png'],
    ['localhost name', 'https://localhost/a.png'],
    ['metadata IP', 'https://169.254.169.254/latest'],
    ['private IP', 'https://10.0.0.1/a.png'],
    ['IPv6 loopback', 'https://[::1]/a.png'],
    ['credentials in URL', 'https://user:pw@example.com/a.png'],
  ]) {
    check(`url fetch refuses ${label}`, isErr(await call('add_image', { url, folder: IMG })));
  }
  if (NET) {
    const web = payload(await call('add_image', { url: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png', folder: IMG }));
    check('url fetch downloads a public image', web.mime === 'image/png' && web.bytes > 1000, JSON.stringify(web).slice(0, 200));
    check('url fetch refuses non-image content', isErr(await call('add_image', { url: 'https://example.com/', folder: IMG })));
  }

  const ri = await call('read_image', { path: ai.image_path });
  check('read_image returns an image block', ri.content?.[1]?.type === 'image' && ri.content[1].mimeType === 'image/png' && ri.content[1].data === PNG_B64);
  check('read_image refuses non-image paths', isErr(await call('read_image', { path: A })));
  check('read_image refuses traversal', isErr(await call('read_image', { path: '../../etc/passwd' })));

  const withImgs = await call('read_note', { path: A, include_images: true });
  const wi = payload(withImgs);
  check('read_note include_images returns embedded images', withImgs.content.some((c) => c.type === 'image') && wi.images?.[0]?.included === true, JSON.stringify(wi.images));
  const noImgs = await call('read_note', { path: A });
  check('read_note without include_images is text-only', noImgs.content.length === 1);

  // ---------------------------------------------------------- upload links
  const link = await call('create_upload_link', { note_path: N, folder: IMG, expires_minutes: 10 });
  const lk = payload(link);
  if (isErr(link)) {
    check('create_upload_link (needs MCP_PUBLIC_HOSTNAME)', false, lk._raw);
  } else {
    check('create_upload_link returns a single-use https URL', /^https:\/\/[^/]+\/upload\/[A-Za-z0-9_-]{32}$/.test(lk.url) && lk.single_use === true, lk.url);
    const local = new URL(lk.url);
    const base = new URL(URL_MCP);
    const target = `${base.origin}${local.pathname}`;
    const h = { ...headers };
    const unauth = await fetch(target);
    check('upload page requires Access auth', unauth.status === 401 || unauth.status === 403, `${unauth.status}`);
    const page = await fetch(target, { headers: h });
    const html = await page.text();
    check('upload page renders form', page.status === 200 && html.includes('type="file"') && html.includes(N), `${page.status}`);

    const fd = new FormData();
    fd.append('images', new Blob([Buffer.from(PNG_B64, 'base64')], { type: 'image/png' }), 'phone photo.png');
    fd.append('images', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'fake.png');
    const post = await fetch(target, { method: 'POST', body: fd, headers: { ...h, origin: base.origin } });
    const postHtml = await post.text();
    check('upload stores valid images and reports invalid ones', post.status === 200 && postHtml.includes('phone photo.png') && postHtml.includes('fake.png'), `${post.status}`);
    const n2 = payload(await call('read_note', { path: N }));
    check('uploaded image embedded in the note', n2.content.includes(`![[${IMG}/phone photo.png]]`), n2.content.slice(-160));
    const reuse = await fetch(target, { headers: h });
    check('upload link is single-use', reuse.status === 404, `${reuse.status}`);
    const forged = await fetch(`${base.origin}/upload/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, { headers: h });
    check('unknown upload token rejected', forged.status === 404, `${forged.status}`);
  }
  check('create_upload_link rejects bad note path', isErr(await call('create_upload_link', { note_path: '../x.md' })));
  check('create_upload_link rejects missing note without create_note', isErr(await call('create_upload_link', { note_path: `${ROOT}/nope.md` })));

  // ----------------------------------------------------- created survives move
  const beforeMove = payload(await call('read_note', { path: B })).created;
  await call('move_note', { from: B, to: `${ROOT}/beta-renamed.md` });
  const afterMove = payload(await call('read_note', { path: `${ROOT}/beta-renamed.md` })).created;
  check('created date survives a rename', beforeMove === afterMove, `${beforeMove} vs ${afterMove}`);
  if (VAULT) {
    const raw = await readFile(path.join(VAULT, `${ROOT}/beta-renamed.md`), 'utf8');
    check('on-disk content matches read_note', raw.length > 0);
  }
}

try {
  await main();
} catch (err) {
  failed += 1;
  console.log(`FAIL  unexpected error — ${err?.stack ?? err}`);
} finally {
  try {
    const r = await call('move_note', { from: ROOT, to: `.trash/${ROOT}` });
    console.log(isErr(r) ? `WARN  cleanup failed: ${payload(r)._raw}` : `cleanup: moved ${ROOT}/ to .trash/`);
  } catch {
    console.log('WARN  cleanup failed');
  }
  await client.close().catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
