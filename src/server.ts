import { createServer } from 'node:http';
import { readFile, writeFile, appendFile, mkdir, stat, unlink, rename, copyFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler, hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';
import * as z from 'zod';
import { Vault, VaultPathError, TRASH_DIR, isSamePathOrInside } from './vault.js';
import { LinkIndex, rewriteLinks, findLinksTo } from './links.js';
import { createAccessVerifier, AccessConfigError } from './access.js';
import type { AccessVerifier } from './access.js';

const SERVER_NAME = 'obsidian-vault';
const SERVER_VERSION = '1.0.0';

const VAULT_ROOT = process.env.VAULT_ROOT ?? '/home/ubuntu/vaults/main';
const BIND_HOST = process.env.MCP_HOST ?? '127.0.0.1';
const BIND_PORT = Number(process.env.MCP_PORT ?? 3000);
const MCP_PATH = '/mcp';

/**
 * Public hostname this server is published under by Cloudflare Tunnel. Tunnel
 * traffic arrives with that Host header, so it has to be on the allowlist
 * alongside loopback; the allowlist is what keeps DNS-rebinding protection
 * meaningful instead of accepting any Host.
 */
const PUBLIC_HOSTNAME = process.env.MCP_PUBLIC_HOSTNAME?.trim();

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
} as const;

const vault = await Vault.open(VAULT_ROOT);

/** Operational logging only. Note contents are never logged. */
function log(event: string, fields: Record<string, string | number | boolean> = {}): void {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`);
  console.log(`[${new Date().toISOString()}] ${event}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
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
    if (err instanceof VaultPathError) {
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

function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ---------------------------------------------------------------- list_notes
  server.registerTool(
    'list_notes',
    {
      description:
        'Recursively list markdown notes in the vault. Returns paths relative to the vault root. Only .md files are returned; .obsidian and .git are excluded.',
      inputSchema: z.object({
        directory: z
          .string()
          .max(1024)
          .optional()
          .describe('Optional vault-relative subdirectory to list. Omit to list the whole vault.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(LIMITS.listMax)
          .optional()
          .describe(`Maximum number of notes to return (default ${LIMITS.listDefault}).`),
      }),
    },
    async ({ directory, limit }) =>
      guard('list_notes', async () => {
        const start =
          directory === undefined || directory.trim() === '' || directory.trim() === '.'
            ? vault.rootPath()
            : await vault.resolve(directory, { mustExist: true, allowRoot: true });

        const st = await stat(start.abs);
        if (!st.isDirectory()) return fail('directory must refer to a directory');

        const cap = limit ?? LIMITS.listDefault;
        const { files, truncated } = await vault.walkMarkdown(start.abs, {
          maxFiles: LIMITS.walkFiles,
          maxDepth: LIMITS.walkDepth,
        });
        const page = files.slice(0, cap);

        log('list_notes', { dir: start.rel || '.', returned: page.length, total: files.length });
        return ok({
          directory: start.rel || '.',
          count: page.length,
          total_found: files.length,
          truncated: truncated || files.length > page.length,
          notes: page,
        });
      })
  );

  // ---------------------------------------------------------------- read_note
  server.registerTool(
    'read_note',
    {
      description:
        'Read a markdown note. Path must be relative to the vault root; paths outside the vault are rejected.',
      inputSchema: z.object({
        path: z.string().max(1024).describe('Vault-relative path to a .md note, e.g. "notes/idea.md".'),
      }),
    },
    async ({ path: notePath }) =>
      guard('read_note', async () => {
        const target = await vault.resolve(notePath, { requireMarkdown: true, mustExist: true });

        const st = await stat(target.abs);
        if (!st.isFile()) return fail('path does not refer to a file');
        if (st.size > LIMITS.readBytes) {
          return fail(`note is too large to read (${st.size} bytes, limit ${LIMITS.readBytes})`);
        }

        const content = await readFile(target.abs, 'utf8');
        log('read_note', { path: target.rel, bytes: st.size });
        return ok({ path: target.rel, bytes: st.size, content });
      })
  );

  // -------------------------------------------------------------- search_notes
  server.registerTool(
    'search_notes',
    {
      description:
        'Case-insensitive plain-text search across markdown notes. Returns matching note paths with surrounding snippets. Results are capped.',
      inputSchema: z.object({
        query: z.string().min(1).max(512).describe('Text to search for (case-insensitive, literal — not a regex).'),
        limit: z
          .number()
          .int()
          .positive()
          .max(LIMITS.searchMax)
          .optional()
          .describe(`Maximum number of matching notes to return (default ${LIMITS.searchDefault}).`),
      }),
    },
    async ({ query, limit }) =>
      guard('search_notes', async () => {
        const needle = query.toLowerCase();
        const cap = limit ?? LIMITS.searchDefault;

        const { files } = await vault.walkMarkdown(vault.rootPath().abs, {
          maxFiles: LIMITS.walkFiles,
          maxDepth: LIMITS.walkDepth,
        });

        const results: Array<{ path: string; matches: number; snippets: string[] }> = [];
        let scanned = 0;
        let truncated = false;

        for (const rel of files) {
          if (results.length >= cap) {
            truncated = true;
            break;
          }
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

          const haystack = text.toLowerCase();
          let index = haystack.indexOf(needle);
          if (index === -1) continue;

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

          results.push({ path: rel, matches, snippets });
        }

        log('search_notes', { query_len: query.length, notes_scanned: scanned, hits: results.length });
        return ok({
          query,
          notes_scanned: scanned,
          result_count: results.length,
          truncated,
          results,
        });
      })
  );

  // --------------------------------------------------------------- write_note
  server.registerTool(
    'write_note',
    {
      description:
        'Create or overwrite a markdown note (UTF-8). Parent directories are created as needed. Only .md paths inside the vault are allowed.',
      inputSchema: z.object({
        path: z.string().max(1024).describe('Vault-relative .md path to write.'),
        content: z.string().max(LIMITS.writeChars).describe('Full UTF-8 note content. Replaces any existing content.'),
      }),
    },
    async ({ path: notePath, content }) =>
      guard('write_note', async () => {
        const target = await vault.resolve(notePath, { requireMarkdown: true });

        await mkdir(path.dirname(target.abs), { recursive: true });
        await writeFile(target.abs, content, { encoding: 'utf8' });

        const bytes = Buffer.byteLength(content, 'utf8');
        log('write_note', { path: target.rel, bytes });
        return ok({ path: target.rel, bytes_written: bytes, created_parents: true });
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
      }),
    },
    async ({ path: notePath, content, create_if_missing }) =>
      guard('append_note', async () => {
        const allowCreate = create_if_missing === true;
        const target = await vault.resolve(notePath, {
          requireMarkdown: true,
          mustExist: !allowCreate,
        });

        let existed = true;
        try {
          const st = await stat(target.abs);
          if (!st.isFile()) return fail('path does not refer to a file');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          existed = false;
          if (!allowCreate) return fail('note does not exist (pass create_if_missing to create it)');
          await mkdir(path.dirname(target.abs), { recursive: true });
        }

        await appendFile(target.abs, content, { encoding: 'utf8' });

        const bytes = Buffer.byteLength(content, 'utf8');
        log('append_note', { path: target.rel, bytes, created: !existed });
        return ok({ path: target.rel, bytes_appended: bytes, created: !existed });
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
      }),
    },
    async ({ path: rel, old_text, new_text, expected_matches }) =>
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

        await writeFile(target.abs, after, 'utf8');

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
          bytes_after: Buffer.byteLength(after),
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

  return server;
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport, bound explicitly to loopback.
// ---------------------------------------------------------------------------
const handler = createMcpHandler(() => buildServer());
const nodeHandler = toNodeHandler(handler);

// Allowlist entries are hostnames only; the SDK strips the port from the Host
// header before comparing, and rejects an entry that carries one.
const allowedHostnames = ['127.0.0.1', 'localhost', ...(PUBLIC_HOSTNAME ? [PUBLIC_HOSTNAME] : [])];
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

async function handleRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse
): Promise<void> {
  // DNS-rebinding / cross-origin guards run before anything else.
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;

  const url = req.url ?? '';
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
    tools: 'list_notes,read_note,search_notes,write_note,append_note,patch_note,delete_note,move_note,get_backlinks',
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
  await handler.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
