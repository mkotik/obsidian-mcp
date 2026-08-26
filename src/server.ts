import { createServer } from 'node:http';
import { readFile, writeFile, appendFile, mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import * as z from 'zod';
import { Vault, VaultPathError } from './vault.js';

const SERVER_NAME = 'obsidian-vault';
const SERVER_VERSION = '1.0.0';

const VAULT_ROOT = process.env.VAULT_ROOT ?? '/home/ubuntu/vaults/main';
const BIND_HOST = process.env.MCP_HOST ?? '127.0.0.1';
const BIND_PORT = Number(process.env.MCP_PORT ?? 3000);
const MCP_PATH = '/mcp';

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

  return server;
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport, bound explicitly to loopback.
// ---------------------------------------------------------------------------
const handler = createMcpHandler(() => buildServer());
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const http = createServer((req, res) => {
  // DNS-rebinding / cross-origin guards run before the MCP handler sees anything.
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;

  const url = req.url ?? '';
  if (url === MCP_PATH || url.startsWith(`${MCP_PATH}?`)) {
    void nodeHandler(req, res);
    return;
  }

  res.statusCode = 404;
  res.setHeader('content-type', 'text/plain');
  res.end('not found\n');
});

http.listen(BIND_PORT, BIND_HOST, () => {
  log('startup', {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    vault: vault.root,
    bind_address: BIND_HOST,
    port: BIND_PORT,
    endpoint: `http://${BIND_HOST}:${BIND_PORT}${MCP_PATH}`,
    tools: 'list_notes,read_note,search_notes,write_note,append_note',
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
