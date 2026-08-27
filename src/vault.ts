import { realpath, stat, readdir } from 'node:fs/promises';
import * as path from 'node:path';

/** Thrown for any rejected client-supplied path. Message is safe to return to the client. */
export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathError';
  }
}

/** Directory names that are never readable, listable, writable, or searchable. */
const EXCLUDED_SEGMENTS = new Set(['.obsidian', '.git']);

/**
 * Directory name used for recoverable deletes. Unlike EXCLUDED_SEGMENTS this is
 * deliberately still addressable: delete_note writes into it, and a note can be
 * restored out of it with move_note. It is only hidden from recursive walks, so
 * trashed notes never pollute list_notes or search_notes results. Listing it
 * explicitly (`list_notes directory=".trash"`) still works.
 */
export const TRASH_DIR = '.trash';

/** Directory names skipped when walking, but still addressable by explicit path. */
const HIDDEN_FROM_WALK = new Set([TRASH_DIR]);

export interface ResolvedPath {
  /** Absolute, fully symlink-resolved path. Never sent to the client. */
  abs: string;
  /** Vault-root-relative path. This is the only form the client ever sees. */
  rel: string;
}

export interface ResolveOptions {
  /** Require a .md extension (all note read/write/append paths). */
  requireMarkdown?: boolean;
  /** Reject if the target does not already exist. */
  mustExist?: boolean;
  /** Allow resolving the vault root itself (used by list_notes). */
  allowRoot?: boolean;
}

/**
 * True when `child` is the same path as `parent` or nested underneath it.
 * Uses path.relative rather than startsWith so a sibling directory whose name
 * merely shares a prefix (`notes-old` vs `notes`) is not treated as nested.
 */
export function isSamePathOrInside(parentAbs: string, childAbs: string): boolean {
  const rel = path.relative(parentAbs, childAbs);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface WalkOptions {
  maxFiles: number;
  maxDepth: number;
}

/**
 * A sandbox around a single vault directory.
 *
 * Every client-supplied path goes through `resolve()`, which enforces:
 *  - relative-only input (no absolute paths, no `~`, no NUL bytes, no drive letters)
 *  - normalization, then containment under the real vault root
 *  - rejection of excluded directories (.obsidian, .git)
 *  - optional .md-only enforcement
 *  - symlink-aware containment: the *real* path (after following links) must still
 *    be inside the vault, so an in-vault symlink pointing at /etc is rejected
 */
export class Vault {
  private constructor(readonly root: string) {}

  /** Resolve the vault root once at startup so later comparisons use a real path. */
  static async open(rawRoot: string): Promise<Vault> {
    const resolved = path.resolve(rawRoot);
    let real: string;
    try {
      real = await realpath(resolved);
    } catch {
      throw new Error(`vault root is not accessible: ${resolved}`);
    }
    const st = await stat(real);
    if (!st.isDirectory()) throw new Error(`vault root is not a directory: ${real}`);
    return new Vault(real);
  }

  /**
   * Containment check based on path.relative rather than a bare startsWith(),
   * so `/home/ubuntu/vaults/main-evil` cannot pass as `/home/ubuntu/vaults/main`.
   */
  private relativeIfContained(abs: string, allowRoot: boolean): string {
    const rel = path.relative(this.root, abs);
    if (rel === '') {
      if (allowRoot) return '';
      throw new VaultPathError('path must refer to a file inside the vault, not the vault root');
    }
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new VaultPathError('path escapes the vault root');
    }
    return rel;
  }

  private assertNotExcluded(rel: string): void {
    for (const segment of rel.split(path.sep)) {
      if (EXCLUDED_SEGMENTS.has(segment)) {
        throw new VaultPathError(`'${segment}' is excluded from this server`);
      }
    }
  }

  /**
   * realpath() that tolerates a not-yet-existing leaf (needed for write_note
   * creating new files/directories). Resolves the deepest existing ancestor and
   * re-attaches the missing segments, so symlinked ancestors are still followed.
   */
  private async realpathAllowingMissing(abs: string, mustExist: boolean): Promise<string> {
    const missing: string[] = [];
    let cursor = abs;

    for (;;) {
      try {
        const real = await realpath(cursor);
        return missing.length === 0 ? real : path.join(real, ...[...missing].reverse());
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw new VaultPathError('path could not be resolved');
        }
        if (mustExist && missing.length === 0) {
          throw new VaultPathError('note does not exist');
        }
        const parent = path.dirname(cursor);
        if (parent === cursor) throw new VaultPathError('path could not be resolved');
        missing.push(path.basename(cursor));
        cursor = parent;
      }
    }
  }

  /** Validate an untrusted client path. Throws VaultPathError on any violation. */
  async resolve(input: unknown, opts: ResolveOptions = {}): Promise<ResolvedPath> {
    if (typeof input !== 'string') throw new VaultPathError('path must be a string');

    const raw = input.trim();
    if (raw.length === 0) throw new VaultPathError('path must not be empty');
    if (raw.length > 1024) throw new VaultPathError('path is too long');
    if (raw.includes('\0')) throw new VaultPathError('path must not contain NUL bytes');
    if (raw.startsWith('~')) throw new VaultPathError('home-relative paths are not allowed');
    if (path.isAbsolute(raw)) throw new VaultPathError('absolute paths are not allowed');
    if (/^[A-Za-z]:[\\/]/.test(raw)) throw new VaultPathError('absolute paths are not allowed');

    // Normalize, then verify containment textually.
    const abs = path.resolve(this.root, raw);
    const rel = this.relativeIfContained(abs, opts.allowRoot === true);
    this.assertNotExcluded(rel);

    if (opts.requireMarkdown && path.extname(abs).toLowerCase() !== '.md') {
      throw new VaultPathError('only .md files are allowed');
    }

    // Re-verify containment after following symlinks.
    const real = await this.realpathAllowingMissing(abs, opts.mustExist === true);
    const realRel = this.relativeIfContained(real, opts.allowRoot === true);
    this.assertNotExcluded(realRel);

    return { abs: real, rel: realRel.split(path.sep).join('/') };
  }

  /** The vault root itself, for list/search starting points. */
  rootPath(): ResolvedPath {
    return { abs: this.root, rel: '' };
  }

  /**
   * Recursively collect .md files under `startAbs`. Symlinks are never followed
   * (withFileTypes + isDirectory/isFile only, so isSymbolicLink entries are skipped).
   */
  async walkMarkdown(startAbs: string, opts: WalkOptions): Promise<{ files: string[]; truncated: boolean }> {
    const files: string[] = [];
    let truncated = false;
    const queue: Array<{ dir: string; depth: number }> = [{ dir: startAbs, depth: 0 }];

    while (queue.length > 0) {
      const { dir, depth } = queue.shift()!;
      if (depth > opts.maxDepth) {
        truncated = true;
        continue;
      }

      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue; // never follow links out of the vault
        if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
        if (HIDDEN_FROM_WALK.has(entry.name)) continue; // trashed notes stay out of results

        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          queue.push({ dir: child, depth: depth + 1 });
        } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
          if (files.length >= opts.maxFiles) {
            truncated = true;
            continue;
          }
          files.push(path.relative(this.root, child).split(path.sep).join('/'));
        }
      }
    }

    files.sort();
    return { files, truncated };
  }
}
