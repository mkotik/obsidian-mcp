/**
 * GitHub "inbox" relay for images attached in a Claude chat.
 *
 * Claude.ai never hands chat-attachment bytes to MCP tools, but Claude's code
 * sandbox has the file and may reach github.com. So the flow is:
 *
 *   1. start_image_upload  -> server returns a push script + a fresh upload id
 *   2. Claude's sandbox    -> git push the file(s) to inbox/<id>/ in a private repo
 *   3. import_uploaded_images -> server downloads them over the GitHub API,
 *      saves them into the vault, embeds them, then rewrites the inbox branch
 *      as a single parentless commit without them, so photos do not linger in
 *      the repo's history.
 *
 * The token is a fine-grained PAT limited to that one repo (Contents: read and
 * write). It is read from a file at call time (systemd LoadCredential=), so it
 * can be rotated without a restart, and it is never logged.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export class InboxError extends Error {}

export interface InboxConfig {
  repo: string; // owner/name
  branch: string;
  apiBase: string; // https://api.github.com (overridable for tests)
  gitBase: string; // https://github.com
  tokenFile: string | null;
  staleHours: number;
}

export function inboxConfigFromEnv(env: NodeJS.ProcessEnv): InboxConfig {
  const credDir = env.CREDENTIALS_DIRECTORY;
  const tokenFile = env.INBOX_TOKEN_FILE ?? (credDir ? path.join(credDir, 'inbox-token') : null);
  return {
    repo: env.INBOX_REPO ?? '',
    branch: env.INBOX_BRANCH ?? 'main',
    apiBase: (env.INBOX_API_BASE ?? 'https://api.github.com').replace(/\/+$/, ''),
    gitBase: (env.INBOX_GIT_BASE ?? 'https://github.com').replace(/\/+$/, ''),
    tokenFile,
    staleHours: Math.max(1, Number(env.INBOX_STALE_HOURS ?? 24)),
  };
}

const ID_RE = /^\d{8}T\d{6}Z-[a-z0-9]{6}$/;
export const INBOX_PREFIX = 'inbox/';

export function newUploadId(now = Date.now()): string {
  const iso = new Date(now).toISOString(); // 2026-10-04T15:56:01.123Z
  const stamp = iso.slice(0, 19).replace(/[-:]/g, '') + 'Z'; // 20261004T155601Z
  const rand = randomBytes(6)
    .toString('base64')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .padEnd(6, '0')
    .slice(0, 6);
  return `${stamp}-${rand}`;
}

export function isUploadId(id: string): boolean {
  return ID_RE.test(id);
}

/** Milliseconds encoded in an upload id, or null. */
export function uploadIdTime(id: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(id);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

export class Inbox {
  constructor(private readonly cfg: InboxConfig) {}

  get configured(): boolean {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.cfg.repo) && this.cfg.tokenFile !== null;
  }

  get repo(): string {
    return this.cfg.repo;
  }

  async token(): Promise<string> {
    if (!this.cfg.tokenFile) throw new InboxError('image inbox is not configured on the server');
    let t: string;
    try {
      t = (await readFile(this.cfg.tokenFile, 'utf8')).trim();
    } catch {
      throw new InboxError('image inbox token is missing on the server');
    }
    if (!/^[A-Za-z0-9_]{20,255}$/.test(t)) throw new InboxError('image inbox token on the server is malformed');
    return t;
  }

  private async api(method: string, p: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<Response> {
    const token = await this.token();
    const res = await fetch(`${this.cfg.apiBase}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'obsidian-mcp-inbox',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
    });
    return res;
  }

  private async json<T>(method: string, p: string, body?: unknown): Promise<T> {
    const res = await this.api(method, p, body);
    if (res.status === 401 || res.status === 403) throw new InboxError(`GitHub refused the inbox token (HTTP ${res.status}); it may have expired`);
    if (!res.ok) throw new InboxError(`GitHub API error (HTTP ${res.status})`);
    return (await res.json()) as T;
  }

  private enc(p: string): string {
    return p.split('/').map(encodeURIComponent).join('/');
  }

  /** Files directly inside inbox/<id>/ (sub-folders are ignored). */
  async listUpload(id: string): Promise<Array<{ path: string; name: string; size: number }>> {
    const res = await this.api('GET', `/repos/${this.cfg.repo}/contents/${this.enc(INBOX_PREFIX + id)}?ref=${encodeURIComponent(this.cfg.branch)}`);
    if (res.status === 404) return [];
    if (res.status === 401 || res.status === 403) throw new InboxError(`GitHub refused the inbox token (HTTP ${res.status}); it may have expired`);
    if (!res.ok) throw new InboxError(`GitHub API error (HTTP ${res.status})`);
    const items = (await res.json()) as unknown;
    if (!Array.isArray(items)) return [];
    return items
      .filter((i): i is { type: string; path: string; name: string; size: number } => !!i && (i as { type?: unknown }).type === 'file')
      .map((i) => ({ path: i.path, name: i.name, size: Number(i.size) || 0 }));
  }

  /** Raw bytes of one file, refusing anything over maxBytes. */
  async download(filePath: string, maxBytes: number): Promise<Buffer> {
    const res = await this.api(
      'GET',
      `/repos/${this.cfg.repo}/contents/${this.enc(filePath)}?ref=${encodeURIComponent(this.cfg.branch)}`,
      undefined,
      'application/vnd.github.raw'
    );
    if (!res.ok) throw new InboxError(`could not download ${path.posix.basename(filePath)} (HTTP ${res.status})`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > maxBytes) throw new InboxError(`${path.posix.basename(filePath)} is larger than the ${Math.round(maxBytes / 1048576)} MB limit`);
    const reader = res.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new InboxError(`${path.posix.basename(filePath)} is larger than the ${Math.round(maxBytes / 1048576)} MB limit`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Rewrite the branch as one parentless commit containing everything except
   * `remove` and stale inbox uploads. Unreachable blobs are then garbage
   * collected by GitHub, so images do not stay in history.
   */
  async purge(remove: Set<string>, now = Date.now()): Promise<{ removed: number; kept: number }> {
    const ref = await this.json<{ object: { sha: string } }>('GET', `/repos/${this.cfg.repo}/git/ref/heads/${encodeURIComponent(this.cfg.branch)}`);
    const commit = await this.json<{ tree: { sha: string } }>('GET', `/repos/${this.cfg.repo}/git/commits/${ref.object.sha}`);
    const tree = await this.json<{ tree: Array<{ path: string; mode: string; type: string; sha: string }>; truncated?: boolean }>(
      'GET',
      `/repos/${this.cfg.repo}/git/trees/${commit.tree.sha}?recursive=1`
    );
    if (tree.truncated) throw new InboxError('inbox repository is too large to clean automatically');

    const staleBefore = now - this.cfg.staleHours * 3600_000;
    const blobs = tree.tree.filter((e) => e.type === 'blob');
    const kept = blobs.filter((e) => {
      if (remove.has(e.path)) return false;
      if (e.path.startsWith(INBOX_PREFIX)) {
        const id = e.path.slice(INBOX_PREFIX.length).split('/')[0];
        const t = uploadIdTime(id);
        if (t === null || t < staleBefore) return false; // unrecognised or abandoned upload
      }
      return true;
    });
    const removed = blobs.length - kept.length;
    if (removed === 0) return { removed: 0, kept: kept.length };

    const entries: Array<Record<string, string>> = kept.map((e) => ({ path: e.path, mode: e.mode, type: 'blob', sha: e.sha }));
    if (entries.length === 0) {
      entries.push({ path: 'README.md', mode: '100644', type: 'blob', content: '# vault-inbox\n\nTransient drop box for images sent to the Obsidian vault. Files are removed once imported.\n' });
    }
    const newTree = await this.json<{ sha: string }>('POST', `/repos/${this.cfg.repo}/git/trees`, { tree: entries });
    const newCommit = await this.json<{ sha: string }>('POST', `/repos/${this.cfg.repo}/git/commits`, {
      message: 'inbox: clear imported uploads',
      tree: newTree.sha,
      parents: [],
    });
    await this.json('PATCH', `/repos/${this.cfg.repo}/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`, { sha: newCommit.sha, force: true });
    return { removed, kept: kept.length };
  }

  /** Bash script Claude's sandbox runs to push files into inbox/<id>/. */
  async pushScript(id: string): Promise<string> {
    const token = await this.token();
    const remote = `${this.cfg.gitBase.replace('://', `://x-access-token:${token}@`)}/${this.cfg.repo}.git`;
    return [
      '#!/usr/bin/env bash',
      '# Usage: bash push.sh FILE [FILE...]   (pushes the files to the vault inbox)',
      'set -uo pipefail',
      '[ $# -ge 1 ] || { echo "usage: bash push.sh FILE [FILE...]"; exit 2; }',
      'for f in "$@"; do [ -f "$f" ] || { echo "not a file: $f"; exit 2; }; done',
      `REMOTE='${remote}'`,
      `DEST='${INBOX_PREFIX}${id}'`,
      `BRANCH='${this.cfg.branch}'`,
      'mask() { sed -E "s#x-access-token:[^@]*@#x-access-token:***@#g"; }',
      'for attempt in 1 2 3; do',
      '  W=$(mktemp -d)',
      '  if git clone -q --depth 1 --branch "$BRANCH" "$REMOTE" "$W/r" 2>"$W/err"; then',
      '    mkdir -p "$W/r/$DEST"',
      '    for f in "$@"; do cp "$f" "$W/r/$DEST/$(basename "$f")"; done',
      '    (cd "$W/r" && git add -A && git -c user.name=claude -c user.email=claude@localhost commit -qm "upload $(basename "$DEST")" \\',
      '      && git push -q origin "HEAD:$BRANCH") 2>"$W/err" && { echo "PUSHED $# file(s) to $DEST"; ls -la "$W/r/$DEST"; rm -rf "$W"; exit 0; }',
      '  fi',
      '  echo "attempt $attempt failed:"; mask <"$W/err"; rm -rf "$W"; sleep 2',
      'done',
      'echo "PUSH FAILED"; exit 1',
      '',
    ].join('\n');
  }
}
