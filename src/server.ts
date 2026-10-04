import { createServer } from 'node:http';
import { readFile, writeFile, appendFile, mkdir, stat, unlink, rename, copyFile, utimes } from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler, hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';
import * as z from 'zod';
import { Vault, VaultPathError, TRASH_DIR, isSamePathOrInside } from './vault.js';
import { LinkIndex, rewriteLinks, findLinksTo, parseLinks } from './links.js';
import { NoteIndex, publicMeta, recencyWeight, parseDateFilter, formatIsoLocal } from './notes.js';
import type { NoteMeta } from './notes.js';
import { stampDates, editTags } from './edit.js';
import { normalizeTag, hasAllTags, inlineTags, tagMatches } from './tags.js';
import { splitFrontmatter } from './frontmatter.js';
import {
  detectImage,
  looksLikeHeic,
  mimeForPath,
  safeStem,
  stampForName,
  decodeBase64Image,
  fetchImage,
  FetchImageError,
  uploadFormPage,
  uploadResultPage,
  messagePage,
} from './images.js';
import type { ImageType } from './images.js';
import { Inbox, InboxError, inboxConfigFromEnv, newUploadId, isUploadId } from './inbox.js';
import { createAccessVerifier, AccessConfigError } from './access.js';
import type { AccessVerifier } from './access.js';

const SERVER_NAME = 'obsidian-vault';
const SERVER_VERSION = '1.2.0';

const VAULT_ROOT = process.env.VAULT_ROOT ?? '/home/ubuntu/vaults/main';
const BIND_HOST = process.env.MCP_HOST ?? '127.0.0.1';
const BIND_PORT = Number(process.env.MCP_PORT ?? 3000);
const MCP_PATH = '/mcp';
const UPLOAD_PATH = '/upload/';

/** Timezone used to interpret and write note dates (`created: YYYY-MM-DD`). */
const TIME_ZONE = process.env.NOTE_TIMEZONE ?? 'America/New_York';

/**
 * Where the persistent created-date index lives. systemd's StateDirectory=
 * sets STATE_DIRECTORY; without either, dates still work but created times are
 * not remembered across restarts.
 */
const STATE_DIR = process.env.STATE_DIR ?? process.env.STATE_DIRECTORY;

/** Ranking: a note's recency weight halves every this many days since it last changed. */
const RECENCY_HALF_LIFE_DAYS = Math.max(1, Number(process.env.RECENCY_HALF_LIFE_DAYS ?? 30));

/** Stamp `created:` / `updated:` frontmatter on notes the server writes. On unless set to "false". */
const STAMP_DATES_DEFAULT = (process.env.STAMP_DATES ?? 'true').toLowerCase() !== 'false';

/** Vault folder for new images, unless a tool call names one. */
const ATTACHMENTS_DIR_ENV = process.env.ATTACHMENTS_DIR;

/**
 * Public hostname(s) this server is published under by Cloudflare Tunnel.
 * Tunnel traffic arrives with that Host header, so each has to be on the
 * allowlist alongside loopback; the allowlist is what keeps DNS-rebinding
 * protection meaningful instead of accepting any Host.
 *
 * Accepts a comma-separated list so a hostname can be migrated without
 * downtime: publish the new name, run both for a cutover window, then drop
 * the old one. Entries are hostnames only — the SDK rejects any that carry a
 * port — and blank entries are discarded so a trailing comma is harmless.
 */
const PUBLIC_HOSTNAMES = (process.env.MCP_PUBLIC_HOSTNAME ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter((h) => h.length > 0);

// ---------------------------------------------------------------------------
// Resource limits. These exist so a malformed or hostile request cannot make
// the process read the whole vault into memory or emit an unbounded response.
// ---------------------------------------------------------------------------
const LIMITS = {
  readBytes: 1024 * 1024, // largest note we will read back
  writeChars: 512 * 1024, // largest content payload accepted
  listDefault: 200,
  listMax: 2000,
  searchDefault: 20,
  searchMax: 100,
  searchFilesScanned: 5000,
  searchFileBytes: 1024 * 1024,
  snippetChars: 240,
  snippetsPerNote: 3,
  walkDepth: 24,
  walkFiles: 20000,
  patchChars: 256 * 1024, // largest single patch anchor / replacement
  backlinksMax: 200,
  linkScanFiles: 5000,
  linkRewriteFiles: 2000,
  tagsPerCall: 20,
  tagsListMax: 1000,
  imageBytes: 20 * 1024 * 1024, // largest image saved into the vault
  imageBase64Chars: 12 * 1024 * 1024, // ~9 MB decoded; base64 is for small images only
  imageReadBytes: 5 * 1024 * 1024, // largest image returned to a client (model input limit)
  noteImagesMax: 4, // images returned by read_note include_images
  noteImagesTotalBytes: 10 * 1024 * 1024,
  uploadRequestBytes: 100 * 1024 * 1024, // one browser upload, all files together
  uploadFilesMax: 20,
  uploadLinkMinutesDefault: 30,
  uploadLinkMinutesMax: 24 * 60,
  uploadLinksActive: 20,
} as const;

const vault = await Vault.open(VAULT_ROOT);
const noteIndex = await NoteIndex.open({
  root: vault.root,
  timeZone: TIME_ZONE,
  stateDir: STATE_DIR,
  maxFileBytes: LIMITS.searchFileBytes,
});

/** GitHub inbox relay for chat-attached images (see inbox.ts). */
const inbox = new Inbox(inboxConfigFromEnv(process.env));

/** Public base URL for upload links, from the first published hostname. */
const PUBLIC_BASE_URL = PUBLIC_HOSTNAMES.length > 0 ? `https://${PUBLIC_HOSTNAMES[0]}` : null;

/** Operational logging only. Note contents are never logged. */
function log(event: string, fields: Record<string, string | number | boolean> = {}): void {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`);
  console.log(`[${new Date().toISOString()}] ${event}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

type ContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = {
  content: ContentBlock[];
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/**
 * Wrap a tool body so that path-validation failures become clean MCP errors and
 * unexpected failures never leak absolute paths or stack traces to the client.
 */
async function guard(tool: string, body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof VaultPathError || err instanceof FetchImageError || err instanceof InboxError) {
      log('tool.rejected', { tool, reason: err.message });
      return fail(err.message);
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log('tool.rejected', { tool, reason: 'not_found' });
      return fail('note does not exist');
    }
    if (code === 'EISDIR') return fail('path refers to a directory, not a note');
    if (code === 'EACCES' || code === 'EPERM') return fail('permission denied');
    log('tool.error', { tool, code: code ?? 'unknown' });
    return fail('internal error handling request');
  }
}

/**
 * Every file in the vault, vault-relative, for wikilink resolution. Includes
 * non-markdown files because embeds such as `![[image.png]]` target them.
 */
async function allVaultFiles(): Promise<string[]> {
  const { files } = await vault.walkMarkdown(vault.root, {
    maxFiles: LIMITS.walkFiles,
    maxDepth: LIMITS.walkDepth,
    allFiles: true,
  });
  return files;
}

/** Read a note as UTF-8, returning null when it is not readable as text. */
async function readNoteText(abs: string): Promise<string | null> {
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > LIMITS.searchFileBytes) return null;
    return await readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dates, tags, and filtering shared by list_notes / search_notes
// ---------------------------------------------------------------------------

const DATE_FILTER_HELP =
  'Accepts YYYY-MM-DD, an ISO timestamp, "today", "yesterday", or a relative age such as "7d", "2w", "3m", "1y" (meaning that long ago).';

/** Zod fields for the filters list_notes and search_notes share. */
const filterFields = {
  tags: z
    .array(z.string().max(80))
    .max(10)
    .optional()
    .describe('Only notes carrying ALL of these tags. Case-insensitive, leading # optional; a parent tag such as "project" also matches nested "project/alpha".'),
  modified_after: z.string().max(40).optional().describe(`Only notes last changed at or after this time. ${DATE_FILTER_HELP}`),
  modified_before: z.string().max(40).optional().describe(`Only notes last changed at or before this time (a bare date includes that whole day). ${DATE_FILTER_HELP}`),
  created_after: z.string().max(40).optional().describe(`Only notes created at or after this time. ${DATE_FILTER_HELP}`),
  created_before: z.string().max(40).optional().describe(`Only notes created at or before this time (a bare date includes that whole day). ${DATE_FILTER_HELP}`),
};

interface FilterInput {
  tags?: string[];
  modified_after?: string;
  modified_before?: string;
  created_after?: string;
  created_before?: string;
}

type NotePredicate = (m: NoteMeta) => boolean;

/** Build a predicate from filter arguments, or return a client-facing error string. */
function buildFilter(input: FilterInput): { test: NotePredicate; active: boolean } | { error: string } {
  const bounds: Array<[keyof FilterInput, 'createdMs' | 'modifiedMs', 'min' | 'max']> = [
    ['modified_after', 'modifiedMs', 'min'],
    ['modified_before', 'modifiedMs', 'max'],
    ['created_after', 'createdMs', 'min'],
    ['created_before', 'createdMs', 'max'],
  ];
  const checks: NotePredicate[] = [];
  for (const [key, field, kind] of bounds) {
    const raw = input[key] as string | undefined;
    if (raw === undefined || raw.trim() === '') continue;
    const at = parseDateFilter(raw, TIME_ZONE, kind === 'max');
    if (at === null) return { error: `${key} "${raw}" is not a recognised date. ${DATE_FILTER_HELP}` };
    checks.push(kind === 'min' ? (m) => m[field] >= at : (m) => m[field] <= at);
  }
  if (input.tags && input.tags.length > 0) {
    const wanted: string[] = [];
    for (const t of input.tags) {
      const n = normalizeTag(t);
      if (!n) return { error: `"${t}" is not a valid tag` };
      wanted.push(n);
    }
    checks.push((m) => hasAllTags(m.tags, wanted));
  }
  return { test: (m) => checks.every((c) => c(m)), active: checks.length > 0 };
}

/** Compact per-note shape used in list/search results. */
function noteSummary(m: NoteMeta): Record<string, unknown> {
  const out: Record<string, unknown> = { path: m.path, created: m.created, modified: m.modified, tags: m.tags };
  if (m.dates_mismatch) out.dates_mismatch = true;
  return out;
}

/** Reference point included in date-bearing responses so "today" is unambiguous. */
function nowStamp(): { now: string; timezone: string } {
  return { now: formatIsoLocal(Date.now(), TIME_ZONE), timezone: TIME_ZONE };
}

/**
 * Write a note's full text, stamping frontmatter dates first when enabled.
 * `createdMs` is the creation time to record if the note has no `created:` yet.
 */
async function writeNoteText(
  abs: string,
  rel: string,
  text: string,
  opts: { stamp: boolean; createdMs: number }
): Promise<{ text: string; stamped: string[] }> {
  let out = text;
  let stamped: string[] = [];
  if (opts.stamp) {
    const r = stampDates(text, { nowMs: Date.now(), createdMs: opts.createdMs, timeZone: TIME_ZONE });
    out = r.text;
    stamped = r.stamped;
  }
  await writeFile(abs, out, 'utf8');
  noteIndex.forget(rel);
  return { text: out, stamped };
}

/** Creation time to preserve for a note about to be rewritten (now, if it is new). */
async function existingCreatedMs(rel: string): Promise<number> {
  const meta = await noteIndex.get(rel);
  return meta?.createdMs ?? Date.now();
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Default attachment folder: ATTACHMENTS_DIR if set, else Obsidian's own
 * `attachmentFolderPath` setting (read directly — .obsidian is not reachable
 * through tools), else `attachments`. Obsidian's "same folder as note" form
 * (`./sub`) is honoured relative to the note being embedded into.
 */
async function defaultAttachmentFolder(noteRel: string | null): Promise<string> {
  if (ATTACHMENTS_DIR_ENV !== undefined && ATTACHMENTS_DIR_ENV.trim() !== '') return ATTACHMENTS_DIR_ENV.trim().replace(/^\/+|\/+$/g, '');
  try {
    const cfg = JSON.parse(await readFile(path.join(vault.root, '.obsidian', 'app.json'), 'utf8')) as { attachmentFolderPath?: unknown };
    const setting = typeof cfg.attachmentFolderPath === 'string' ? cfg.attachmentFolderPath.trim() : '';
    if (setting.startsWith('./')) {
      const base = noteRel ? path.posix.dirname(noteRel) : '';
      return path.posix.join(base === '.' ? '' : base, setting.slice(2)).replace(/^\/+|\/+$/g, '');
    }
    if (setting !== '' && setting !== '/') return setting.replace(/^\/+|\/+$/g, '');
  } catch {
    // no app.json on this host: fall through
  }
  return 'attachments';
}

/**
 * Save image bytes into the vault with a collision-free name. The extension
 * always comes from the detected format, never from the caller.
 */
async function saveImage(
  data: Buffer,
  type: ImageType,
  opts: { filename?: string; folder: string }
): Promise<{ rel: string; bytes: number }> {
  if (data.length > LIMITS.imageBytes) {
    throw new VaultPathError(`image is larger than the ${LIMITS.imageBytes / 1048576} MB limit`);
  }
  const named = opts.filename !== undefined && opts.filename.trim() !== '';
  const stem = named ? safeStem(opts.filename) : `${safeStem(undefined)} ${stampForName(Date.now(), TIME_ZONE)}`;
  const folder = opts.folder.replace(/^\/+|\/+$/g, '');

  const dir = await vault.resolve(folder === '' ? '.' : folder, { allowRoot: true });
  for (let n = 0; n < 1000; n += 1) {
    const name = `${stem}${n === 0 ? '' : ` ${n}`}.${type.ext}`;
    const target = await vault.resolve(dir.rel === '' ? name : `${dir.rel}/${name}`);
    await mkdir(path.dirname(target.abs), { recursive: true });
    try {
      await writeFile(target.abs, data, { flag: 'wx' }); // never overwrite an existing file
      return { rel: target.rel, bytes: data.length };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new VaultPathError('could not find a free file name for the image');
}

/** `![[path]]` or `![[path|width]]`. Path form is used so the embed can never be ambiguous. */
function embedFor(rel: string, width?: number): string {
  return `![[${rel}${width ? `|${width}` : ''}]]`;
}

/**
 * Insert embeds into a note: after the line containing `afterText` (which must
 * match exactly once), or at the end. Creates the note when `create` is set.
 */
async function embedInNote(
  noteRel: string,
  embeds: string[],
  opts: { afterText?: string; create: boolean; stamp: boolean }
): Promise<{ path: string; created: boolean; stamped: string[] }> {
  const target = await vault.resolve(noteRel, { requireMarkdown: true });
  let text = '';
  let existed = true;
  try {
    const st = await stat(target.abs);
    if (!st.isFile()) throw new VaultPathError('note_path does not refer to a note');
    if (st.size > LIMITS.readBytes) throw new VaultPathError('note is too large to edit');
    text = await readFile(target.abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (!opts.create) throw new VaultPathError('note_path does not exist (pass create_note to create it)');
    existed = false;
  }

  const block = embeds.join('\n');
  let updated: string;
  if (opts.afterText !== undefined && opts.afterText !== '') {
    const first = text.indexOf(opts.afterText);
    if (first === -1) throw new VaultPathError('after_text was not found in the note; nothing was changed');
    if (text.indexOf(opts.afterText, first + opts.afterText.length) !== -1) {
      throw new VaultPathError('after_text appears more than once; include more surrounding text so it is unique');
    }
    const lineEnd = text.indexOf('\n', first + opts.afterText.length);
    const at = lineEnd === -1 ? text.length : lineEnd;
    updated = `${text.slice(0, at)}\n${block}${text.slice(at)}`;
  } else {
    const sep = text.length === 0 ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    updated = `${text}${sep}${block}\n`;
  }
  if (updated.length > LIMITS.writeChars + LIMITS.readBytes) throw new VaultPathError('resulting note would be too large');

  await mkdir(path.dirname(target.abs), { recursive: true });
  const createdMs = existed ? await existingCreatedMs(target.rel) : Date.now();
  const { stamped } = await writeNoteText(target.abs, target.rel, updated, { stamp: opts.stamp, createdMs });
  return { path: target.rel, created: !existed, stamped };
}

/** Read an image file as an MCP image content block, enforcing the size limit. */
async function imageBlock(abs: string, rel: string): Promise<{ type: 'image'; data: string; mimeType: string; bytes: number }> {
  const st = await stat(abs);
  if (!st.isFile()) throw new VaultPathError('path does not refer to a file');
  if (st.size > LIMITS.imageReadBytes) {
    throw new VaultPathError(`image is ${(st.size / 1048576).toFixed(1)} MB; images over ${LIMITS.imageReadBytes / 1048576} MB cannot be returned to the client`);
  }
  const data = await readFile(abs);
  const type = detectImage(data);
  if (!type) throw new VaultPathError(`${rel} is not a PNG, JPEG, GIF, or WebP image`);
  return { type: 'image', data: data.toString('base64'), mimeType: type.mime, bytes: st.size };
}

// ---------------------------------------------------------------------------
// Single-use browser upload links
// ---------------------------------------------------------------------------

interface UploadGrant {
  notePath: string | null;
  folder: string;
  expiresAt: number;
  createNote: boolean;
}

/** In memory by design: a restart revokes every outstanding link. */
const uploadGrants = new Map<string, UploadGrant>();

function sweepUploadGrants(): void {
  const now = Date.now();
  for (const [token, g] of uploadGrants) if (g.expiresAt <= now) uploadGrants.delete(token);
}

function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ---------------------------------------------------------------- list_notes
  server.registerTool(
    'list_notes',
    {
      description:
        'List markdown notes with their created date, last-modified date, and tags. Newest-changed first by default, so recently edited notes come first. ' +
        'Filter by tag and/or by created/modified date range — e.g. "what did I change this week" is modified_after="7d"; "notes tagged project" is tags=["project"]. ' +
        'Only .md files are returned; .obsidian, .git and .trash are excluded.',
      inputSchema: z.object({
        directory: z
          .string()
          .max(1024)
          .optional()
          .describe('Optional vault-relative subdirectory to list. Omit to list the whole vault.'),
        ...filterFields,
        sort: z
          .enum(['modified', 'created', 'path'])
          .optional()
          .describe('modified (default): most recently changed first. created: newest first. path: alphabetical.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(LIMITS.listMax)
          .optional()
          .describe(`Maximum number of notes to return (default ${LIMITS.listDefault}).`),
      }),
    },
    async ({ directory, sort, limit, ...filters }) =>
      guard('list_notes', async () => {
        const start =
          directory === undefined || directory.trim() === '' || directory.trim() === '.'
            ? vault.rootPath()
            : await vault.resolve(directory, { mustExist: true, allowRoot: true });

        const st = await stat(start.abs);
        if (!st.isDirectory()) return fail('directory must refer to a directory');

        const filter = buildFilter(filters);
        if ('error' in filter) return fail(filter.error);

        const cap = limit ?? LIMITS.listDefault;
        const { files, truncated } = await vault.walkMarkdown(start.abs, {
          maxFiles: LIMITS.walkFiles,
          maxDepth: LIMITS.walkDepth,
        });
        const metas = (await noteIndex.getMany(files)).filter(filter.test);

        const order = sort ?? 'modified';
        if (order === 'modified') metas.sort((a, b) => b.modifiedMs - a.modifiedMs);
        else if (order === 'created') metas.sort((a, b) => b.createdMs - a.createdMs);
        else metas.sort((a, b) => a.path.localeCompare(b.path));

        const page = metas.slice(0, cap);
        log('list_notes', { dir: start.rel || '.', returned: page.length, total: metas.length, filtered: filter.active });
        return ok({
          directory: start.rel || '.',
          ...nowStamp(),
          sort: order,
          count: page.length,
          total_found: metas.length,
          truncated: truncated || metas.length > page.length,
          notes: page.map(noteSummary),
        });
      })
  );

  // ---------------------------------------------------------------- read_note
  server.registerTool(
    'read_note',
    {
      description:
        'Read a markdown note, with its created date, last-modified date, and tags. Path must be relative to the vault root. ' +
        'Set include_images=true to also receive the images the note embeds (![[image.png]]) so you can see them.',
      inputSchema: z.object({
        path: z.string().max(1024).describe('Vault-relative path to a .md note, e.g. "notes/idea.md".'),
        include_images: z
          .boolean()
          .optional()
          .describe(`Return embedded images as image content (up to ${LIMITS.noteImagesMax}). Defaults to false.`),
      }),
    },
    async ({ path: notePath, include_images }) =>
      guard('read_note', async () => {
        const target = await vault.resolve(notePath, { requireMarkdown: true, mustExist: true });

        const st = await stat(target.abs);
        if (!st.isFile()) return fail('path does not refer to a file');
        if (st.size > LIMITS.readBytes) {
          return fail(`note is too large to read (${st.size} bytes, limit ${LIMITS.readBytes})`);
        }

        const content = await readFile(target.abs, 'utf8');
        const meta = await noteIndex.get(target.rel, content);

        const images: ContentBlock[] = [];
        const imageReport: Array<{ path: string; included: boolean; reason?: string }> = [];
        if (include_images === true) {
          const embeds = parseLinks(content).filter((l) => l.embed && mimeForPath(l.target) !== null);
          if (embeds.length > 0) {
            const index = new LinkIndex(await allVaultFiles());
            let total = 0;
            for (const e of embeds) {
              const resolved = index.resolve(e.target);
              if (!resolved) {
                imageReport.push({ path: e.target, included: false, reason: 'not found in vault' });
                continue;
              }
              if (imageReport.some((r) => r.path === resolved)) continue;
              if (images.length >= LIMITS.noteImagesMax) {
                imageReport.push({ path: resolved, included: false, reason: 'image limit reached; use read_image' });
                continue;
              }
              try {
                const ref = await vault.resolve(resolved, { mustExist: true });
                const block = await imageBlock(ref.abs, ref.rel);
                if (total + block.bytes > LIMITS.noteImagesTotalBytes) {
                  imageReport.push({ path: ref.rel, included: false, reason: 'size budget reached; use read_image' });
                  continue;
                }
                total += block.bytes;
                images.push({ type: 'image', data: block.data, mimeType: block.mimeType });
                imageReport.push({ path: ref.rel, included: true });
              } catch (err) {
                imageReport.push({ path: resolved, included: false, reason: err instanceof VaultPathError ? err.message : 'unreadable' });
              }
            }
          }
        }

        log('read_note', { path: target.rel, bytes: st.size, images: images.length });
        const body: Record<string, unknown> = {
          path: target.rel,
          bytes: st.size,
          ...(meta ? publicMeta(meta) : {}),
          content,
        };
        if (include_images === true) body.images = imageReport;
        const result = ok(body);
        result.content.push(...images);
        return result;
      })
  );

  // -------------------------------------------------------------- search_notes
  server.registerTool(
    'search_notes',
    {
      description:
        'Case-insensitive plain-text search across markdown notes (body, file name, and tags). ' +
        'Results are ranked by relevance weighted toward recently changed notes, so a note edited this week outranks an equally relevant one untouched for months. ' +
        'Supports the same tag and created/modified date filters as list_notes. Each result carries created/modified dates, tags, and snippets.',
      inputSchema: z.object({
        query: z.string().min(1).max(512).describe('Text to search for (case-insensitive, literal — not a regex).'),
        ...filterFields,
        sort: z
          .enum(['relevance', 'modified', 'created'])
          .optional()
          .describe('relevance (default): match strength weighted by recency. modified / created: newest first among matches.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(LIMITS.searchMax)
          .optional()
          .describe(`Maximum number of matching notes to return (default ${LIMITS.searchDefault}).`),
      }),
    },
    async ({ query, sort, limit, ...filters }) =>
      guard('search_notes', async () => {
        const needle = query.toLowerCase();
        const cap = limit ?? LIMITS.searchDefault;
        const filter = buildFilter(filters);
        if ('error' in filter) return fail(filter.error);

        const { files } = await vault.walkMarkdown(vault.rootPath().abs, {
          maxFiles: LIMITS.walkFiles,
          maxDepth: LIMITS.walkDepth,
        });

        type Hit = { meta: NoteMeta; matches: number; snippets: string[]; score: number; matched_in: string[] };
        const hits: Hit[] = [];
        let scanned = 0;
        let truncated = false;
        const now = Date.now();
        const needleTag = normalizeTag(query);

        for (const rel of files) {
          if (scanned >= LIMITS.searchFilesScanned) {
            truncated = true;
            break;
          }

          const abs = path.join(vault.rootPath().abs, rel);
          let st;
          try {
            st = await stat(abs);
          } catch {
            continue;
          }
          if (!st.isFile() || st.size > LIMITS.searchFileBytes) continue;

          scanned += 1;
          let text: string;
          try {
            text = await readFile(abs, 'utf8');
          } catch {
            continue;
          }

          const meta = await noteIndex.get(rel, text);
          if (!meta || !filter.test(meta)) continue;

          const name = path.posix.basename(rel, path.posix.extname(rel)).toLowerCase();
          const inName = name.includes(needle);
          const inTags = meta.tags.some((t) => t.toLowerCase().includes(needle) || (needleTag !== null && tagMatches(t, needleTag)));

          const haystack = text.toLowerCase();
          let index = haystack.indexOf(needle);
          if (index === -1 && !inName && !inTags) continue;

          const snippets: string[] = [];
          let matches = 0;
          while (index !== -1) {
            matches += 1;
            if (snippets.length < LIMITS.snippetsPerNote) {
              const half = Math.floor((LIMITS.snippetChars - needle.length) / 2);
              const from = Math.max(0, index - half);
              const to = Math.min(text.length, index + needle.length + half);
              const snippet = `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${
                to < text.length ? '…' : ''
              }`;
              snippets.push(snippet);
            }
            index = haystack.indexOf(needle, index + needle.length);
          }

          // Relevance: a title or tag hit is a strong signal; body hits add with
          // diminishing returns so one long note cannot drown out the rest.
          const relevance = (inName ? 3 : 0) + (inTags ? 2 : 0) + Math.log2(1 + matches);
          // Recency multiplier in [0.4, 1]: recent edits lift a note, but an old
          // note that matches much better still wins.
          const score = relevance * (0.4 + 0.6 * recencyWeight(meta.modifiedMs, RECENCY_HALF_LIFE_DAYS, now));
          const matched_in = [...(inName ? ['name'] : []), ...(inTags ? ['tags'] : []), ...(matches > 0 ? ['body'] : [])];
          hits.push({ meta, matches, snippets, score, matched_in });
        }

        const order = sort ?? 'relevance';
        if (order === 'relevance') hits.sort((a, b) => b.score - a.score || b.meta.modifiedMs - a.meta.modifiedMs);
        else if (order === 'modified') hits.sort((a, b) => b.meta.modifiedMs - a.meta.modifiedMs);
        else hits.sort((a, b) => b.meta.createdMs - a.meta.createdMs);

        const page = hits.slice(0, cap);
        log('search_notes', { query_len: query.length, notes_scanned: scanned, hits: hits.length, filtered: filter.active });
        return ok({
          query,
          ...nowStamp(),
          sort: order,
          notes_scanned: scanned,
          total_matches: hits.length,
          result_count: page.length,
          truncated: truncated || hits.length > page.length,
          results: page.map((h) => ({
            ...noteSummary(h.meta),
            matches: h.matches,
            matched_in: h.matched_in,
            score: Math.round(h.score * 100) / 100,
            snippets: h.snippets,
          })),
        });
      })
  );

  // --------------------------------------------------------------- write_note
  server.registerTool(
    'write_note',
    {
      description:
        'Create or overwrite a markdown note (UTF-8). Parent directories are created as needed. Only .md paths inside the vault are allowed. ' +
        'Frontmatter created:/updated: dates are maintained automatically; an existing note keeps its original created date even if the new content omits it. ' +
        'To add tags, prefer update_tags after writing (it reuses the vault\'s existing tag vocabulary).',
      inputSchema: z.object({
        path: z.string().max(1024).describe('Vault-relative .md path to write.'),
        content: z.string().max(LIMITS.writeChars).describe('Full UTF-8 note content. Replaces any existing content.'),
        stamp_dates: z
          .boolean()
          .optional()
          .describe(
            `Keep frontmatter dates current: add created: (if missing) and refresh updated: to today. Defaults to ${STAMP_DATES_DEFAULT}.`
          ),
      }),
    },
    async ({ path: notePath, content, stamp_dates }) =>
      guard('write_note', async () => {
        const target = await vault.resolve(notePath, { requireMarkdown: true });

        await mkdir(path.dirname(target.abs), { recursive: true });
        const createdMs = await existingCreatedMs(target.rel);
        const written = await writeNoteText(target.abs, target.rel, content, {
          stamp: stamp_dates ?? STAMP_DATES_DEFAULT,
          createdMs,
        });

        const bytes = Buffer.byteLength(written.text, 'utf8');
        log('write_note', { path: target.rel, bytes });
        return ok({ path: target.rel, bytes_written: bytes, created_parents: true, dates_stamped: written.stamped });
      })
  );

  // -------------------------------------------------------------- append_note
  server.registerTool(
    'append_note',
    {
      description:
        'Append UTF-8 text to an existing markdown note. Set create_if_missing to create the note when it does not exist. Only .md paths inside the vault are allowed.',
      inputSchema: z.object({
        path: z.string().max(1024).describe('Vault-relative .md path to append to.'),
        content: z.string().max(LIMITS.writeChars).describe('UTF-8 text to append to the end of the note.'),
        create_if_missing: z
          .boolean()
          .optional()
          .describe('Create the note (and parent directories) if it does not already exist. Defaults to false.'),
        stamp_dates: z
          .boolean()
          .optional()
          .describe(
            `Keep frontmatter dates current: add created: (if missing) and refresh updated: to today. Defaults to ${STAMP_DATES_DEFAULT}.`
          ),
      }),
    },
    async ({ path: notePath, content, create_if_missing, stamp_dates }) =>
      guard('append_note', async () => {
        const allowCreate = create_if_missing === true;
        const target = await vault.resolve(notePath, {
          requireMarkdown: true,
          mustExist: !allowCreate,
        });

        let existed = true;
        let size = 0;
        try {
          const st = await stat(target.abs);
          if (!st.isFile()) return fail('path does not refer to a file');
          size = st.size;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          existed = false;
          if (!allowCreate) return fail('note does not exist (pass create_if_missing to create it)');
          await mkdir(path.dirname(target.abs), { recursive: true });
        }

        // Stamping needs a whole-file rewrite; for a note too large to read back
        // safely, fall back to a plain append rather than refusing the write.
        const stamp = (stamp_dates ?? STAMP_DATES_DEFAULT) && size <= LIMITS.readBytes;
        let stamped: string[] = [];
        if (stamp) {
          const before = existed ? await readFile(target.abs, 'utf8') : '';
          const createdMs = existed ? await existingCreatedMs(target.rel) : Date.now();
          stamped = (await writeNoteText(target.abs, target.rel, before + content, { stamp: true, createdMs })).stamped;
        } else {
          await appendFile(target.abs, content, { encoding: 'utf8' });
          noteIndex.forget(target.rel);
        }

        const bytes = Buffer.byteLength(content, 'utf8');
        log('append_note', { path: target.rel, bytes, created: !existed });
        return ok({ path: target.rel, bytes_appended: bytes, created: !existed, dates_stamped: stamped });
      })
  );

  // -------------------------------------------------------------- delete_note
  server.registerTool(
    'delete_note',
    {
      description:
        'Delete a markdown note. By default the note is moved to the vault\'s .trash/ folder (recoverable, and restorable with move_note) rather than erased. Pass permanent=true to erase it irreversibly. Only .md paths inside the vault are allowed.',
      inputSchema: z.object({
        path: z.string().max(1024).describe('Vault-relative .md path to delete.'),
        permanent: z
          .boolean()
          .optional()
          .describe(
            'Erase the file instead of moving it to .trash/. Irreversible, and the deletion propagates through Obsidian Sync. Defaults to false.'
          ),
      }),
    },
    async ({ path: notePath, permanent }) =>
      guard('delete_note', async () => {
        const target = await vault.resolve(notePath, { requireMarkdown: true, mustExist: true });

        const st = await stat(target.abs);
        if (!st.isFile()) return fail('path does not refer to a note');

        // Refuse to recurse on the trash folder itself: permanently deleting from
        // inside .trash is allowed, but soft-deleting a trashed file is a no-op loop.
        const inTrash = target.rel === TRASH_DIR || target.rel.startsWith(`${TRASH_DIR}/`);

        noteIndex.forget(target.rel);
        if (permanent === true || inTrash) {
          await unlink(target.abs);
          log('delete_note', { path: target.rel, permanent: true, bytes: st.size });
          return ok({ path: target.rel, deleted: true, permanent: true, recoverable: false });
        }

        // Soft delete: .trash/<timestamp>/<original path>, preserving structure so
        // two notes with the same basename cannot collide and restores are obvious.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashRel = `${TRASH_DIR}/${stamp}/${target.rel}`;
        const trashTarget = await vault.resolve(trashRel, { requireMarkdown: true });

        await mkdir(path.dirname(trashTarget.abs), { recursive: true });
        try {
          await rename(target.abs, trashTarget.abs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
          await copyFile(target.abs, trashTarget.abs);
          await unlink(target.abs);
        }

        log('delete_note', { path: target.rel, permanent: false, bytes: st.size });
        return ok({
          path: target.rel,
          deleted: true,
          permanent: false,
          recoverable: true,
          trash_path: trashTarget.rel,
          restore_hint: `move_note from="${trashTarget.rel}" to="${target.rel}"`,
        });
      })
  );

  // ---------------------------------------------------------------- move_note
  server.registerTool(
    'move_note',
    {
      description:
        'Move or rename a note or a folder inside the vault. Works for a single .md note or an entire directory (including any attachments it contains), so the vault can be reorganised. Wikilinks pointing at anything that moved are rewritten by default, and the response lists every note that was edited. Parent directories of the destination are created as needed. Fails if the destination already exists unless overwrite=true (files only).',
      inputSchema: z.object({
        from: z.string().max(1024).describe('Existing vault-relative .md note path, or a directory path.'),
        to: z
          .string()
          .max(1024)
          .describe('New vault-relative path. Must end in .md when moving a note; a directory path when moving a folder.'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Replace the destination note if it already exists. Ignored for directories, which never overwrite. Defaults to false.'),
        update_links: z
          .boolean()
          .optional()
          .describe('Rewrite [[wikilinks]] elsewhere in the vault so they still point at the moved file(s). Defaults to true.'),
      }),
    },
    async ({ from, to, overwrite, update_links }) =>
      guard('move_note', async () => {
        const source = await vault.resolve(from, { mustExist: true });
        const sourceStat = await stat(source.abs);
        const isDirectory = sourceStat.isDirectory();

        if (!isDirectory && !sourceStat.isFile()) {
          return fail('source is neither a note nor a folder');
        }
        // Files keep the same .md-only rule the write tools enforce.
        if (!isDirectory && path.extname(source.abs).toLowerCase() !== '.md') {
          return fail('only .md notes can be moved individually (move the containing folder instead)');
        }

        const target = await vault.resolve(to, { requireMarkdown: !isDirectory });

        if (target.rel === source.rel) return fail('source and destination are the same path');

        // Moving a folder into itself or into its own descendant would either fail
        // mid-operation or silently orphan files, so reject it up front.
        if (isDirectory && isSamePathOrInside(source.abs, target.abs)) {
          return fail('cannot move a folder into itself or into one of its own subfolders');
        }

        let destExisted = false;
        try {
          const destStat = await stat(target.abs);
          destExisted = true;
          if (isDirectory || destStat.isDirectory()) {
            return fail('destination already exists');
          }
          if (overwrite !== true) {
            return fail('destination already exists (pass overwrite to replace it)');
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }

        const rewriting = update_links !== false;

        // Snapshot the pre-move file list so links can be resolved against the
        // vault as it was, then map every file that is about to move.
        const filesBefore = rewriting ? await allVaultFiles() : [];
        const moved = new Map<string, string>();
        if (rewriting) {
          if (isDirectory) {
            const prefix = `${source.rel}/`;
            for (const f of filesBefore) {
              if (f.startsWith(prefix)) moved.set(f, `${target.rel}/${f.slice(prefix.length)}`);
            }
          } else {
            moved.set(source.rel, target.rel);
          }
        }

        await mkdir(path.dirname(target.abs), { recursive: true });
        await rename(source.abs, target.abs);

        // Keep created dates attached to notes that moved, so a rename does not
        // make an old note look new.
        if (isDirectory) {
          const prefix = `${source.rel}/`;
          const movedNotes = new Map<string, string>();
          const { files: after } = await vault.walkMarkdown(target.abs, { maxFiles: LIMITS.walkFiles, maxDepth: LIMITS.walkDepth });
          for (const f of after) movedNotes.set(`${prefix}${f.slice(target.rel.length + 1)}`, f);
          noteIndex.recordMove(movedNotes);
        } else {
          noteIndex.recordMove(new Map([[source.rel, target.rel]]));
        }

        // Link rewriting happens after the move so the "after" index reflects
        // reality. A failure here cannot corrupt a note: each file is rewritten
        // only when its own edit set is non-empty, and each write is whole-file
        // from text we just read.
        const linkEdits: Array<{ path: string; edits: unknown[] }> = [];
        let linksTruncated = false;

        if (rewriting && moved.size > 0) {
          const indexBefore = new LinkIndex(filesBefore);
          const filesAfter = await allVaultFiles();
          const indexAfter = new LinkIndex(filesAfter);

          const movedTargets = new Set(moved.values());
          let scanned = 0;

          for (const note of filesAfter) {
            if (!/\.md$/i.test(note)) continue;
            if (movedTargets.has(note)) continue; // links inside a moved note keep resolving
            if (scanned >= LIMITS.linkRewriteFiles) {
              linksTruncated = true;
              break;
            }
            scanned += 1;

            const abs = path.join(vault.root, note);
            const text = await readNoteText(abs);
            if (text === null || !text.includes('[[')) continue;

            const { text: updated, edits } = rewriteLinks(text, moved, indexBefore, indexAfter);
            if (edits.length === 0) continue;

            await writeFile(abs, updated, 'utf8');
            linkEdits.push({ path: note, edits });
          }
        }

        const linksChanged = linkEdits.reduce((n, f) => n + f.edits.length, 0);
        log('move_note', {
          from: source.rel,
          to: target.rel,
          kind: isDirectory ? 'directory' : 'file',
          overwritten: destExisted,
          files_moved: moved.size,
          notes_relinked: linkEdits.length,
          links_rewritten: linksChanged,
        });
        return ok({
          from: source.rel,
          to: target.rel,
          kind: isDirectory ? 'directory' : 'file',
          overwritten: destExisted,
          files_moved: isDirectory ? moved.size : 1,
          links_updated: {
            enabled: rewriting,
            notes_edited: linkEdits.length,
            links_rewritten: linksChanged,
            truncated: linksTruncated,
            details: linkEdits,
          },
        });
      })
  );

  server.registerTool(
    'patch_note',
    {
      description:
        'Replace an exact snippet of text inside an existing note, leaving the rest of the file untouched. Prefer this over write_note for editing an existing note: write_note replaces the whole file, so a partial rewrite can silently drop content. The anchor must match exactly; if it is missing or appears a different number of times than expected, nothing is written and the tool reports what it found.',
      inputSchema: z.object({
        path: z.string().max(1024).describe('Vault-relative .md note path. Must already exist.'),
        old_text: z
          .string()
          .min(1)
          .max(LIMITS.patchChars)
          .describe('Exact text to find, including whitespace and newlines. Must be unique unless expected_matches says otherwise.'),
        new_text: z
          .string()
          .max(LIMITS.patchChars)
          .describe('Replacement text. Pass an empty string to delete the matched text.'),
        expected_matches: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('How many occurrences of old_text are expected. Defaults to 1. The patch is refused unless the count matches exactly.'),
        stamp_dates: z
          .boolean()
          .optional()
          .describe(
            `Keep frontmatter dates current: add created: (if missing) and refresh updated: to today. Defaults to ${STAMP_DATES_DEFAULT}.`
          ),
      }),
    },
    async ({ path: rel, old_text, new_text, expected_matches, stamp_dates }) =>
      guard('patch_note', async () => {
        const target = await vault.resolve(rel, { requireMarkdown: true, mustExist: true });

        const st = await stat(target.abs);
        if (!st.isFile()) return fail('path refers to a directory, not a note');
        if (st.size > LIMITS.readBytes) return fail('note is too large to patch');

        const before = await readFile(target.abs, 'utf8');

        // Count occurrences without regex, so the anchor is always literal.
        let count = 0;
        let at = before.indexOf(old_text);
        while (at !== -1) {
          count += 1;
          at = before.indexOf(old_text, at + old_text.length);
          if (count > 1000) break;
        }

        const expected = expected_matches ?? 1;
        if (count === 0) {
          log('patch_note.rejected', { path: target.rel, reason: 'anchor_not_found' });
          return fail('old_text was not found in the note; nothing was changed');
        }
        if (count !== expected) {
          log('patch_note.rejected', { path: target.rel, reason: 'match_count', found: count, expected });
          return fail(
            `old_text appears ${count} time(s) but expected_matches is ${expected}; nothing was changed. ` +
              'Include more surrounding text to make the anchor unique, or set expected_matches to the real count.'
          );
        }

        const after = before.split(old_text).join(new_text);
        if (after.length > LIMITS.writeChars) return fail('resulting note would exceed the size limit');

        const createdMs = await existingCreatedMs(target.rel);
        const written = await writeNoteText(target.abs, target.rel, after, {
          stamp: stamp_dates ?? STAMP_DATES_DEFAULT,
          createdMs,
        });

        log('patch_note', {
          path: target.rel,
          replacements: count,
          bytes_before: Buffer.byteLength(before),
          bytes_after: Buffer.byteLength(after),
        });
        return ok({
          path: target.rel,
          replacements: count,
          bytes_before: Buffer.byteLength(before),
          bytes_after: Buffer.byteLength(written.text),
          dates_stamped: written.stamped,
        });
      })
  );

  server.registerTool(
    'get_backlinks',
    {
      description:
        'List notes that link to the given note via an Obsidian wikilink ([[Note]] or an embed). Resolves both bare-name and path-form links, so it finds references search_notes would miss. Returns each referring note with the matching line numbers and link text.',
      inputSchema: z.object({
        path: z.string().max(1024).describe('Vault-relative .md note path to find references to.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(LIMITS.backlinksMax)
          .optional()
          .describe(`Maximum referring notes to return (default ${LIMITS.searchDefault}).`),
      }),
    },
    async ({ path: rel, limit }) =>
      guard('get_backlinks', async () => {
        const target = await vault.resolve(rel, { requireMarkdown: true, mustExist: true });
        const cap = limit ?? LIMITS.searchDefault;

        const files = await allVaultFiles();
        const index = new LinkIndex(files);

        const notes = files.filter((f) => /\.md$/i.test(f));
        const results: Array<{ path: string; references: number; matches: unknown[] }> = [];
        let scanned = 0;
        let truncated = false;

        for (const note of notes) {
          if (note === target.rel) continue; // self-links are not backlinks
          if (scanned >= LIMITS.linkScanFiles) {
            truncated = true;
            break;
          }
          scanned += 1;

          const text = await readNoteText(path.join(vault.root, note));
          if (text === null || !text.includes('[[')) continue;

          const hits = findLinksTo(text, target.rel, index);
          if (hits.length === 0) continue;

          if (results.length >= cap) {
            truncated = true;
            break;
          }
          results.push({ path: note, references: hits.length, matches: hits });
        }

        const total = results.reduce((n, r) => n + r.references, 0);
        log('get_backlinks', { path: target.rel, notes: results.length, references: total, scanned });
        return ok({ path: target.rel, referring_notes: results.length, total_references: total, truncated, results });
      })
  );

  // ---------------------------------------------------------------- list_tags
  server.registerTool(
    'list_tags',
    {
      description:
        'List every tag used in the vault (frontmatter tags: and inline #tags) with how many notes use it and when it was last used. ' +
        'Call this before tagging a note so you reuse the vault\'s existing vocabulary instead of inventing near-duplicates (e.g. "ml" vs "machine-learning").',
      inputSchema: z.object({
        prefix: z.string().max(80).optional().describe('Only tags starting with this text, e.g. "project" to see project/* tags.'),
        directory: z.string().max(1024).optional().describe('Only count notes under this vault-relative folder.'),
        limit: z.number().int().positive().max(LIMITS.tagsListMax).optional().describe('Maximum tags to return (default 200).'),
      }),
    },
    async ({ prefix, directory, limit }) =>
      guard('list_tags', async () => {
        const start =
          directory === undefined || directory.trim() === '' || directory.trim() === '.'
            ? vault.rootPath()
            : await vault.resolve(directory, { mustExist: true, allowRoot: true });
        const { files } = await vault.walkMarkdown(start.abs, { maxFiles: LIMITS.walkFiles, maxDepth: LIMITS.walkDepth });
        const metas = await noteIndex.getMany(files);

        const counts = new Map<string, { tag: string; notes: number; lastMs: number }>();
        for (const m of metas) {
          for (const t of m.tags) {
            const k = t.toLowerCase();
            const entry = counts.get(k) ?? { tag: t, notes: 0, lastMs: 0 };
            entry.notes += 1;
            entry.lastMs = Math.max(entry.lastMs, m.modifiedMs);
            counts.set(k, entry);
          }
        }
        const p = prefix?.trim().replace(/^#/, '').toLowerCase();
        const all = [...counts.values()]
          .filter((e) => !p || e.tag.toLowerCase().startsWith(p))
          .sort((a, b) => b.notes - a.notes || b.lastMs - a.lastMs);
        const cap = limit ?? 200;
        const untagged = metas.filter((m) => m.tags.length === 0).length;

        log('list_tags', { tags: all.length, notes: metas.length });
        return ok({
          notes_scanned: metas.length,
          untagged_notes: untagged,
          tag_count: all.length,
          truncated: all.length > cap,
          tags: all.slice(0, cap).map((e) => ({ tag: e.tag, notes: e.notes, last_used: formatIsoLocal(e.lastMs, TIME_ZONE) })),
        });
      })
  );

  // -------------------------------------------------------------- update_tags
  server.registerTool(
    'update_tags',
    {
      description:
        'Add and/or remove tags on a note, editing only its frontmatter tags: list (other frontmatter and the body are untouched). ' +
        'To tag intelligently: read the note, call list_tags, then pick 1-5 tags that describe its topic, type, or project, reusing existing tags wherever one fits; ' +
        'only coin a new tag when nothing existing fits, using lowercase kebab-case (nested like "project/alpha" is fine). ' +
        'By default the note keeps its last-modified time, so bulk re-tagging does not make old notes look recently changed.',
      inputSchema: z.object({
        path: z.string().max(1024).describe('Vault-relative .md note path. Must already exist.'),
        add: z.array(z.string().max(80)).max(LIMITS.tagsPerCall).optional().describe('Tags to add. Leading # optional.'),
        remove: z.array(z.string().max(80)).max(LIMITS.tagsPerCall).optional().describe('Tags to remove from frontmatter.'),
        preserve_modified: z
          .boolean()
          .optional()
          .describe('Keep the note\'s modified time (nudged by 1 second so sync still sees the change). Defaults to true. Set false to treat the edit as a real update.'),
      }),
    },
    async ({ path: rel, add, remove, preserve_modified }) =>
      guard('update_tags', async () => {
        const target = await vault.resolve(rel, { requireMarkdown: true, mustExist: true });
        const st = await stat(target.abs);
        if (!st.isFile()) return fail('path refers to a directory, not a note');
        if (st.size > LIMITS.readBytes) return fail('note is too large to edit');
        if ((add?.length ?? 0) === 0 && (remove?.length ?? 0) === 0) return fail('pass at least one tag in add or remove');

        const invalid: string[] = [];
        const norm = (list: string[] | undefined) =>
          (list ?? []).flatMap((t) => {
            const n = normalizeTag(t);
            if (!n) invalid.push(t);
            return n ? [n] : [];
          });
        const toAdd = norm(add);
        const toRemove = norm(remove);
        if (invalid.length > 0) {
          return fail(`invalid tag(s): ${invalid.map((t) => JSON.stringify(t)).join(', ')}. Tags may use letters, numbers, -, _ and /, and must not be purely numeric.`);
        }

        const before = await readFile(target.abs, 'utf8');
        const result = editTags(before, toAdd, toRemove);
        if ('error' in result) return fail(result.error);

        const preserve = preserve_modified !== false;
        if (result.changed) {
          await writeFile(target.abs, result.text, 'utf8');
          if (preserve) {
            const mtime = new Date(st.mtimeMs + 1000);
            await utimes(target.abs, st.atime, mtime);
          }
          noteIndex.forget(target.rel);
        }

        // Inline #tags live in prose and are never rewritten; say so if a removal left one behind.
        const inlineLeft = toRemove.filter((t) => inlineTags(splitFrontmatter(result.text).body).some((i) => i.toLowerCase() === t.toLowerCase()));
        const meta = await noteIndex.get(target.rel);

        log('update_tags', { path: target.rel, added: result.added.length, removed: result.removed.length });
        return ok({
          path: target.rel,
          changed: result.changed,
          added: result.added,
          removed: result.removed,
          frontmatter_tags: result.after,
          all_tags: meta?.tags ?? result.after,
          modified_preserved: result.changed && preserve,
          ...(inlineLeft.length > 0
            ? { still_inline: inlineLeft, note: 'These tags also appear inline as #tag in the body; edit the text with patch_note to remove them there.' }
            : {}),
        });
      })
  );

  // ---------------------------------------------------------------- add_image
  server.registerTool(
    'add_image',
    {
      description:
        'Save an image into the vault and optionally embed it in a note as ![[...]]. Provide exactly one source: ' +
        'url (a public https image — the server downloads it) or data_base64 (only for small images whose bytes you actually have, e.g. a generated chart). ' +
        'For an image the user attached in chat, you cannot pass its bytes here — use start_image_upload instead. ' +
        'Supported: PNG, JPEG, GIF, WebP. The format is checked from the bytes.',
      inputSchema: z.object({
        url: z.string().max(4096).optional().describe('https:// URL of the image to download.'),
        data_base64: z
          .string()
          .max(LIMITS.imageBase64Chars)
          .optional()
          .describe('Base64 image bytes, or a data:image/...;base64, URL.'),
        filename: z.string().max(200).optional().describe('File name (without extension) to save as. Defaults to "image <timestamp>".'),
        folder: z.string().max(1024).optional().describe('Vault-relative folder to save into. Defaults to the vault\'s attachments folder.'),
        note_path: z.string().max(1024).optional().describe('Vault-relative .md note to embed the image in.'),
        after_text: z
          .string()
          .max(LIMITS.patchChars)
          .optional()
          .describe('Embed on a new line after the line containing this exact text (must occur once). Omit to append at the end.'),
        width: z.number().int().min(16).max(4000).optional().describe('Display width in pixels, written as ![[image.png|width]].'),
        create_note: z.boolean().optional().describe('Create note_path if it does not exist. Defaults to false.'),
      }),
    },
    async ({ url, data_base64, filename, folder, note_path, after_text, width, create_note }) =>
      guard('add_image', async () => {
        if ((url ? 1 : 0) + (data_base64 ? 1 : 0) !== 1) return fail('provide exactly one of url or data_base64');
        if (note_path !== undefined) await vault.resolve(note_path, { requireMarkdown: true }); // validate before saving anything

        let data: Buffer;
        let type: ImageType;
        let suggested = filename;
        if (url) {
          const got = await fetchImage(url, LIMITS.imageBytes);
          data = got.data;
          type = got.type;
          if (suggested === undefined) {
            const base = decodeURIComponent(new URL(got.finalUrl).pathname.split('/').pop() ?? '');
            if (base.replace(/\.[A-Za-z0-9]{1,5}$/, '').length >= 3) suggested = base;
          }
        } else {
          const decoded = decodeBase64Image(data_base64!);
          if (!decoded || decoded.length === 0) return fail('data_base64 is not valid base64');
          const detected = detectImage(decoded);
          if (!detected) return fail(looksLikeHeic(decoded) ? 'HEIC images are not supported; convert to JPEG or PNG' : 'data is not a PNG, JPEG, GIF, or WebP image');
          data = decoded;
          type = detected;
        }

        const dest = folder ?? (await defaultAttachmentFolder(note_path ?? null));
        const saved = await saveImage(data, type, { filename: suggested, folder: dest });
        const embed = embedFor(saved.rel, width);

        let embedded: Awaited<ReturnType<typeof embedInNote>> | null = null;
        if (note_path !== undefined) {
          try {
            embedded = await embedInNote(note_path, [embed], { afterText: after_text, create: create_note === true, stamp: STAMP_DATES_DEFAULT });
          } catch (err) {
            // The image is saved either way; report the embed failure instead of losing the file.
            log('add_image', { image: saved.rel, bytes: saved.bytes, embedded: false });
            return ok({
              image_path: saved.rel,
              bytes: saved.bytes,
              mime: type.mime,
              embed,
              embedded: false,
              embed_error: err instanceof VaultPathError ? err.message : 'could not edit the note',
            });
          }
        }

        log('add_image', { image: saved.rel, bytes: saved.bytes, embedded: embedded !== null, source: url ? 'url' : 'base64' });
        return ok({
          image_path: saved.rel,
          bytes: saved.bytes,
          mime: type.mime,
          embed,
          embedded: embedded !== null,
          ...(embedded ? { note_path: embedded.path, note_created: embedded.created, dates_stamped: embedded.stamped } : {}),
        });
      })
  );

  // --------------------------------------------------------------- read_image
  server.registerTool(
    'read_image',
    {
      description: 'View an image stored in the vault (PNG, JPEG, GIF, WebP up to 5 MB). Returns the image itself so you can see it.',
      inputSchema: z.object({
        path: z.string().max(1024).describe('Vault-relative path to the image, e.g. "attachments/diagram.png".'),
      }),
    },
    async ({ path: rel }) =>
      guard('read_image', async () => {
        const target = await vault.resolve(rel, { mustExist: true });
        if (!mimeForPath(target.rel)) return fail('path is not a PNG, JPEG, GIF, or WebP file');
        const block = await imageBlock(target.abs, target.rel);
        log('read_image', { path: target.rel, bytes: block.bytes });
        return {
          content: [
            { type: 'text', text: JSON.stringify({ path: target.rel, bytes: block.bytes, mime: block.mimeType }, null, 2) },
            { type: 'image', data: block.data, mimeType: block.mimeType },
          ],
        };
      })
  );

  // ------------------------------------------------------- create_upload_link
  server.registerTool(
    'create_upload_link',
    {
      description:
        'Create a single-use web link where the user can upload images (from a phone or computer) straight into the vault, optionally embedding them in a note. ' +
        'Fallback only: for an image attached in chat, use start_image_upload first; offer this link only if that fails or you have no code execution. ' +
        'Give them the link, and after they say it is done, read_note shows the new embeds. ' +
        'The page is protected by the same login as this server.',
      inputSchema: z.object({
        note_path: z.string().max(1024).optional().describe('Vault-relative .md note to embed the uploaded images in (appended at the end).'),
        folder: z.string().max(1024).optional().describe('Vault-relative folder for the images. Defaults to the attachments folder.'),
        create_note: z.boolean().optional().describe('Create note_path on upload if it does not exist. Defaults to false.'),
        expires_minutes: z
          .number()
          .int()
          .min(5)
          .max(LIMITS.uploadLinkMinutesMax)
          .optional()
          .describe(`How long the link stays valid (default ${LIMITS.uploadLinkMinutesDefault} minutes).`),
      }),
    },
    async ({ note_path, folder, create_note, expires_minutes }) =>
      guard('create_upload_link', async () => {
        if (!PUBLIC_BASE_URL) return fail('upload links need MCP_PUBLIC_HOSTNAME to be configured on the server');
        sweepUploadGrants();
        if (uploadGrants.size >= LIMITS.uploadLinksActive) return fail('too many active upload links; wait for some to expire');

        let noteRel: string | null = null;
        if (note_path !== undefined) {
          const note = await vault.resolve(note_path, { requireMarkdown: true });
          noteRel = note.rel;
          if (create_note !== true) {
            try {
              await stat(note.abs);
            } catch {
              return fail('note_path does not exist (pass create_note to create it on upload)');
            }
          }
        }
        const dest = folder ?? (await defaultAttachmentFolder(noteRel));
        const dir = await vault.resolve(dest === '' ? '.' : dest, { allowRoot: true });

        const token = randomBytes(24).toString('base64url');
        const minutes = expires_minutes ?? LIMITS.uploadLinkMinutesDefault;
        const expiresAt = Date.now() + minutes * 60_000;
        uploadGrants.set(token, { notePath: noteRel, folder: dir.rel, expiresAt, createNote: create_note === true });

        log('create_upload_link', { note: noteRel ?? '-', minutes });
        return ok({
          url: `${PUBLIC_BASE_URL}${UPLOAD_PATH}${token}`,
          expires_at: formatIsoLocal(expiresAt, TIME_ZONE),
          single_use: true,
          note_path: noteRel,
          folder: dir.rel || '.',
          instructions: 'Share this link with the user. They open it, sign in if asked, pick images, and press Upload. Then call read_note to confirm the embeds.',
        });
      })
  );

  // ------------------------------------------------------- start_image_upload
  server.registerTool(
    'start_image_upload',
    {
      description:
        'Step 1 of adding an image the user attached in chat to the vault (preferred over create_upload_link). ' +
        'Returns an upload_id and a bash script. In your code execution sandbox: save the script to /tmp/push.sh and run ' +
        '`bash /tmp/push.sh <file>...` on the attached file(s) (look in /mnt/user-data/uploads/; run `ls -la` there). ' +
        'It git-pushes them to a private relay repo on github.com. When it prints PUSHED, call import_uploaded_images with the same upload_id. ' +
        'HEIC is not supported: convert to JPEG in the sandbox first. Never show the script or its URL to the user; it contains a credential.',
      inputSchema: z.object({}),
    },
    async () =>
      guard('start_image_upload', async () => {
        if (!inbox.configured) return fail('the image inbox is not configured on this server; use create_upload_link instead');
        const id = newUploadId();
        const script = await inbox.pushScript(id);
        log('start_image_upload', { upload_id: id });
        return ok({
          upload_id: id,
          script,
          next: 'Write script to /tmp/push.sh in your code sandbox, run: bash /tmp/push.sh /mnt/user-data/uploads/<file> ..., then call import_uploaded_images with this upload_id.',
          if_push_fails: 'If git cannot reach github.com from the sandbox, fall back to create_upload_link.',
        });
      })
  );

  // --------------------------------------------------- import_uploaded_images
  server.registerTool(
    'import_uploaded_images',
    {
      description:
        'Step 2 after start_image_upload: pull the pushed images into the vault (attachments folder by default), optionally embed them in a note, ' +
        'and delete them from the relay repo. Supported: PNG, JPEG, GIF, WebP.',
      inputSchema: z.object({
        upload_id: z.string().max(64).describe('The upload_id returned by start_image_upload.'),
        note_path: z.string().max(1024).optional().describe('Vault-relative .md note to embed the images in.'),
        after_text: z
          .string()
          .max(LIMITS.patchChars)
          .optional()
          .describe('Embed on a new line after the line containing this exact text (must occur once). Omit to append at the end.'),
        width: z.number().int().min(16).max(4000).optional().describe('Display width in pixels for the embeds.'),
        filename: z.string().max(200).optional().describe('File name (without extension) to save as. With several images, a number is appended.'),
        folder: z.string().max(1024).optional().describe('Vault-relative folder. Defaults to the attachments folder.'),
        create_note: z.boolean().optional().describe('Create note_path if it does not exist. Defaults to false.'),
      }),
    },
    async ({ upload_id, note_path, after_text, width, filename, folder, create_note }) =>
      guard('import_uploaded_images', async () => {
        if (!inbox.configured) return fail('the image inbox is not configured on this server');
        if (!isUploadId(upload_id)) return fail('upload_id is not valid; call start_image_upload first');
        if (note_path !== undefined) await vault.resolve(note_path, { requireMarkdown: true });

        const files = await inbox.listUpload(upload_id);
        if (files.length === 0) return fail('nothing has been pushed for this upload_id yet (did the push script print PUSHED?)');
        if (files.length > 20) return fail('too many files in one upload (max 20)');

        const dest = folder ?? (await defaultAttachmentFolder(note_path ?? null));
        const saved: Array<{ path: string; bytes: number; mime: string }> = [];
        const errors: string[] = [];
        for (const f of files) {
          try {
            if (f.size > LIMITS.imageBytes) throw new InboxError(`${f.name} is larger than the ${LIMITS.imageBytes / 1048576} MB limit`);
            const data = await inbox.download(f.path, LIMITS.imageBytes);
            const type = detectImage(data);
            if (!type) {
              errors.push(`${f.name}: ${looksLikeHeic(data) ? 'HEIC is not supported; convert to JPEG and upload again' : 'not a PNG, JPEG, GIF, or WebP image'}`);
              continue;
            }
            const stem = filename !== undefined && filename.trim() !== '' ? filename : f.name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
            const s = await saveImage(data, type, { filename: stem.length >= 1 ? stem : undefined, folder: dest });
            saved.push({ path: s.rel, bytes: s.bytes, mime: type.mime });
          } catch (err) {
            if (err instanceof InboxError || err instanceof VaultPathError) errors.push(`${f.name}: ${err.message}`);
            else throw err;
          }
        }

        let embedded: Awaited<ReturnType<typeof embedInNote>> | null = null;
        let embedError: string | undefined;
        const embeds = saved.map((s) => embedFor(s.path, width));
        if (note_path !== undefined && embeds.length > 0) {
          try {
            embedded = await embedInNote(note_path, embeds, { afterText: after_text, create: create_note === true, stamp: STAMP_DATES_DEFAULT });
          } catch (err) {
            embedError = err instanceof VaultPathError ? err.message : 'could not edit the note';
          }
        }

        // Remove the upload from the relay repo whatever happened; the vault now holds the copies.
        let cleanup: string;
        try {
          const r = await inbox.purge(new Set(files.map((f) => f.path)));
          cleanup = `removed ${r.removed} file(s) from the relay repo`;
        } catch (err) {
          cleanup = `could not clean the relay repo: ${err instanceof InboxError ? err.message : 'error'}`;
        }

        log('import_uploaded_images', { upload_id, saved: saved.length, failed: errors.length, embedded: embedded !== null });
        if (saved.length === 0) return fail(`no images imported. ${errors.join('; ')}`);
        return ok({
          images: saved,
          embeds,
          embedded: embedded !== null,
          ...(embedded ? { note_path: embedded.path, note_created: embedded.created, dates_stamped: embedded.stamped } : {}),
          ...(embedError ? { embed_error: embedError } : {}),
          ...(errors.length ? { errors } : {}),
          cleanup,
        });
      })
  );

  return server;
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport, bound explicitly to loopback.
// ---------------------------------------------------------------------------
const handler = createMcpHandler(() => buildServer());
const nodeHandler = toNodeHandler(handler);

// Allowlist entries are hostnames only; the SDK strips the port from the Host
// header before comparing, and rejects an entry that carries one.
const allowedHostnames = ['127.0.0.1', 'localhost', ...PUBLIC_HOSTNAMES];
const validateHost = hostHeaderValidation(allowedHostnames);
const validateOrigin = originValidation(allowedHostnames);

/**
 * Cloudflare Access verifier. Constructed at startup and intentionally NOT
 * optional: if CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD are missing or malformed
 * the process exits instead of serving the vault unauthenticated.
 */
function buildAccessVerifier(): AccessVerifier {
  try {
    return createAccessVerifier({
      teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
      aud: process.env.CF_ACCESS_AUD,
    });
  } catch (err) {
    if (err instanceof AccessConfigError) {
      log('fatal', { error: 'access configuration invalid', detail: err.message });
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
}

const accessVerifier = buildAccessVerifier();

/** 401 with a standards-shaped Bearer challenge and a JSON-RPC error body. */
function rejectUnauthenticated(res: import('node:http').ServerResponse, reason: string): void {
  res.statusCode = 401;
  res.setHeader('www-authenticate', `Bearer realm="${SERVER_NAME}", error="invalid_token"`);
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'unauthorized' },
      id: null,
    })
  );
  // Permitted log vocabulary only. No token, no claims, no identity.
  log(`Authentication rejected: ${reason}`);
}

// ---------------------------------------------------------------------------
// Browser upload endpoint: GET shows a form, POST stores the images.
// Reached only after the same Access JWT check as /mcp, plus the unguessable
// single-use token in the path.
// ---------------------------------------------------------------------------

function sendHtml(res: import('node:http').ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  res.end(html);
}

/** Pass a request body through, failing once it exceeds `max` bytes. */
function byteLimit(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > max) cb(new Error('upload too large'));
      else cb(null, chunk);
    },
  });
}

async function handleUpload(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  token: string
): Promise<void> {
  sweepUploadGrants();
  const grant = uploadGrants.get(token);
  if (!grant) {
    sendHtml(res, 404, messagePage('Link expired', 'This upload link is invalid, already used, or expired. Ask for a new one.'));
    return;
  }
  const maxMb = Math.round(LIMITS.imageBytes / 1048576);

  if (req.method === 'GET' || req.method === 'HEAD') {
    sendHtml(res, 200, uploadFormPage({ action: `${UPLOAD_PATH}${token}`, notePath: grant.notePath, folder: grant.folder || '(vault root)', expiresAt: grant.expiresAt, maxMb }));
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('allow', 'GET, POST');
    res.end();
    return;
  }

  const type = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data;/i.test(type)) {
    sendHtml(res, 415, messagePage('Unsupported upload', 'Expected a multipart form upload.'));
    return;
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > LIMITS.uploadRequestBytes) {
    sendHtml(res, 413, messagePage('Too large', `Uploads are limited to ${LIMITS.uploadRequestBytes / 1048576} MB in total.`));
    return;
  }

  let form: FormData;
  try {
    const body = Readable.toWeb(req.pipe(byteLimit(LIMITS.uploadRequestBytes))) as ReadableStream<Uint8Array>;
    form = await new Request('http://localhost/upload', { method: 'POST', headers: { 'content-type': type }, body, duplex: 'half' } as RequestInit).formData();
  } catch {
    sendHtml(res, 400, messagePage('Upload failed', 'The upload could not be read. It may be too large; try fewer or smaller images.'));
    return;
  }

  const files = form.getAll('images').filter((v): v is File => typeof v !== 'string');
  const saved: Array<{ path: string; bytes: number }> = [];
  const errors: string[] = [];
  for (const file of files.slice(0, LIMITS.uploadFilesMax)) {
    const name = file.name || 'image';
    if (file.size === 0) continue;
    if (file.size > LIMITS.imageBytes) {
      errors.push(`${name}: larger than ${maxMb} MB`);
      continue;
    }
    const data = Buffer.from(await file.arrayBuffer());
    const detected = detectImage(data);
    if (!detected) {
      errors.push(`${name}: ${looksLikeHeic(data) ? 'HEIC is not supported — choose "Most Compatible" in iPhone camera settings, or share as JPEG' : 'not a PNG, JPEG, GIF, or WebP image'}`);
      continue;
    }
    try {
      const stored = await saveImage(data, detected, { filename: name, folder: grant.folder });
      saved.push({ path: stored.rel, bytes: stored.bytes });
    } catch (err) {
      errors.push(`${name}: ${err instanceof VaultPathError ? err.message : 'could not be saved'}`);
    }
  }
  if (files.length > LIMITS.uploadFilesMax) errors.push(`only the first ${LIMITS.uploadFilesMax} files were processed`);
  if (files.length === 0) errors.push('no files were selected');

  let notePath: string | null = null;
  if (saved.length > 0) {
    uploadGrants.delete(token); // single use: consumed once anything is stored
    if (grant.notePath) {
      try {
        const r = await embedInNote(grant.notePath, saved.map((s) => embedFor(s.path)), { create: grant.createNote, stamp: STAMP_DATES_DEFAULT });
        notePath = r.path;
      } catch (err) {
        errors.push(`images were saved but could not be embedded in the note: ${err instanceof VaultPathError ? err.message : 'edit failed'}`);
      }
    }
  }

  log('upload', { saved: saved.length, rejected: errors.length, embedded: notePath !== null });
  sendHtml(res, saved.length > 0 ? 200 : 400, uploadResultPage({ saved, errors, notePath }));
}

async function handleRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse
): Promise<void> {
  // DNS-rebinding / cross-origin guards run before anything else.
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;

  const url = req.url ?? '';
  const uploadMatch = /^\/upload\/([A-Za-z0-9_-]{20,64})$/.exec(url.split('?')[0]);
  if (uploadMatch) {
    const auth = await accessVerifier.verify(req);
    if (!auth.ok) {
      rejectUnauthenticated(res, auth.reason);
      return;
    }
    await handleUpload(req, res, uploadMatch[1]);
    return;
  }

  if (!(url === MCP_PATH || url.startsWith(`${MCP_PATH}?`))) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain');
    res.end('not found\n');
    return;
  }

  // Every /mcp request must carry a valid Cloudflare Access assertion. There is
  // no localhost exemption by design.
  const auth = await accessVerifier.verify(req);
  if (!auth.ok) {
    rejectUnauthenticated(res, auth.reason);
    return;
  }
  log('Authentication succeeded');

  await nodeHandler(req, res);
}

const http = createServer((req, res) => {
  void handleRequest(req, res).catch(() => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain');
      res.end('internal error\n');
    } else {
      res.end();
    }
  });
});

http.listen(BIND_PORT, BIND_HOST, () => {
  log('startup', {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    vault: vault.root,
    bind_address: BIND_HOST,
    port: BIND_PORT,
    endpoint: `http://${BIND_HOST}:${BIND_PORT}${MCP_PATH}`,
    tools:
      'list_notes,read_note,search_notes,write_note,append_note,patch_note,delete_note,move_note,get_backlinks,list_tags,update_tags,add_image,read_image,create_upload_link,start_image_upload,import_uploaded_images',
    timezone: TIME_ZONE,
    created_index: noteIndex.persistent ? 'persistent' : 'memory-only',
    allowed_hostnames: allowedHostnames.join(','),
    auth: 'cloudflare-access-jwt',
    auth_issuer: accessVerifier.issuer,
    auth_jwks: accessVerifier.jwksUrl,
    auth_audience_configured: true,
  });
});

async function shutdown(signal: string): Promise<void> {
  log('shutdown', { signal });
  http.close();
  await noteIndex.flush();
  await handler.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
