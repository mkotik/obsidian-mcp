/**
 * Obsidian wikilink parsing and rewriting.
 *
 * Only wikilinks are handled (`[[Note]]`, `![[image.png]]`, with optional
 * `#heading` and `|alias` parts). Markdown-style `[text](note.md)` links are
 * deliberately not rewritten — see the note on `rewriteLinks` below.
 *
 * Link resolution mirrors Obsidian's own behaviour closely enough to be safe:
 * a target containing `/` is treated as a vault-root-relative path, and a bare
 * target is matched against file basenames. Where a bare target is ambiguous
 * (two notes with the same basename) resolution deliberately gives up rather
 * than guessing, so an ambiguous link is left untouched instead of being
 * rewritten to point somewhere the user did not mean.
 */

/** A single wikilink occurrence found in note text. */
export interface ParsedLink {
  /** Full matched text, e.g. `![[folder/Note#Heading|Alias]]`. */
  raw: string;
  /** Index of `raw` within the source text. */
  index: number;
  /** True when the link is an embed (`![[...]]`). */
  embed: boolean;
  /** The target portion only, e.g. `folder/Note`. Never includes `#` or `|`. */
  target: string;
  /** Heading/block portion including the leading `#`, or '' when absent. */
  heading: string;
  /** Alias portion including the leading `|`, or '' when absent. */
  alias: string;
}

/**
 * Matches `[[...]]` and `![[...]]`. The inner group excludes `]` and newlines so
 * an unclosed bracket cannot swallow the rest of the file.
 */
const WIKILINK = /(!?)\[\[([^\][\r\n]+)\]\]/g;

/** Parse every wikilink in `text`, in order of appearance. */
export function parseLinks(text: string): ParsedLink[] {
  const out: ParsedLink[] = [];
  for (const m of text.matchAll(WIKILINK)) {
    const inner = m[2];

    // Split off the alias first: an alias may legitimately contain '#'.
    const pipe = inner.indexOf('|');
    const beforeAlias = pipe === -1 ? inner : inner.slice(0, pipe);
    const alias = pipe === -1 ? '' : inner.slice(pipe);

    const hash = beforeAlias.indexOf('#');
    const target = (hash === -1 ? beforeAlias : beforeAlias.slice(0, hash)).trim();
    const heading = hash === -1 ? '' : beforeAlias.slice(hash);

    // `[[#Heading]]` is a link within the same note; it has no target to resolve.
    if (target === '') continue;

    out.push({
      raw: m[0],
      index: m.index,
      embed: m[1] === '!',
      target,
      heading,
      alias,
    });
  }
  return out;
}

/**
 * An index of every file in the vault, used to resolve link targets to paths.
 * Built from vault-relative paths with '/' separators.
 */
export class LinkIndex {
  /** basename (with extension, lowercased) -> rel paths */
  private byName = new Map<string, string[]>();
  /** basename without extension (lowercased) -> rel paths */
  private byStem = new Map<string, string[]>();
  /** lowercased rel path -> rel path as stored */
  private byPath = new Map<string, string>();

  constructor(relPaths: readonly string[]) {
    for (const rel of relPaths) {
      this.byPath.set(rel.toLowerCase(), rel);

      const base = rel.slice(rel.lastIndexOf('/') + 1);
      push(this.byName, base.toLowerCase(), rel);

      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      push(this.byStem, stem.toLowerCase(), rel);
    }
  }

  /**
   * Resolve a link target to a vault-relative path, or null when it cannot be
   * resolved unambiguously (missing, or an ambiguous bare basename).
   */
  resolve(target: string): string | null {
    const t = target.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

    if (t.includes('/')) {
      return this.byPath.get(t) ?? this.byPath.get(`${t}.md`) ?? null;
    }
    return unique(this.byName.get(t)) ?? unique(this.byStem.get(t)) ?? null;
  }

  /** True when exactly one file in the vault has this basename-without-extension. */
  isStemUnique(stem: string): boolean {
    return (this.byStem.get(stem.toLowerCase()) ?? []).length === 1;
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function unique(list: string[] | undefined): string | null {
  return list && list.length === 1 ? list[0] : null;
}

/** Strip a trailing `.md` (case-insensitive); other extensions are kept. */
function dropMarkdownExt(rel: string): string {
  return /\.md$/i.test(rel) ? rel.slice(0, -3) : rel;
}

function basenameOf(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/**
 * Choose the link text for `newRel`, preserving the style of the original link:
 * a bare target stays bare when that remains unambiguous, and a path-form target
 * stays path-form.
 */
function preferredTarget(oldTarget: string, newRel: string, indexAfterMove: LinkIndex): string {
  const wasPathForm = oldTarget.includes('/');
  const bare = dropMarkdownExt(basenameOf(newRel));

  if (!wasPathForm && indexAfterMove.isStemUnique(bare)) return bare;
  return dropMarkdownExt(newRel);
}

/** One rewritten link, for reporting back to the caller. */
export interface LinkEdit {
  from: string;
  to: string;
}

export interface RewriteResult {
  text: string;
  edits: LinkEdit[];
}

/**
 * Rewrite links in `text` so that any link resolving (against the pre-move vault
 * state) to a key of `moved` instead points at its new path.
 *
 * `moved` maps old vault-relative path -> new vault-relative path.
 *
 * Note on markdown-style links: this vault contains none, and rewriting them
 * correctly requires URL-encoding rules that differ between Obsidian versions,
 * so they are left alone rather than being rewritten incorrectly. `move_note`
 * reports what it changed, so a link style it does not handle stays visible
 * rather than being silently mangled.
 */
export function rewriteLinks(
  text: string,
  moved: ReadonlyMap<string, string>,
  indexBeforeMove: LinkIndex,
  indexAfterMove: LinkIndex
): RewriteResult {
  const links = parseLinks(text);
  if (links.length === 0) return { text, edits: [] };

  const edits: LinkEdit[] = [];
  let out = '';
  let cursor = 0;

  for (const link of links) {
    const oldRel = indexBeforeMove.resolve(link.target);
    if (oldRel === null) continue;

    const newRel = moved.get(oldRel);
    if (newRel === undefined) continue;

    const newTarget = preferredTarget(link.target, newRel, indexAfterMove);
    if (newTarget === link.target) continue; // already correct, e.g. a bare link after a folder move

    const replacement = `${link.embed ? '!' : ''}[[${newTarget}${link.heading}${link.alias}]]`;
    out += text.slice(cursor, link.index) + replacement;
    cursor = link.index + link.raw.length;
    edits.push({ from: link.raw, to: replacement });
  }

  if (edits.length === 0) return { text, edits: [] };
  return { text: out + text.slice(cursor), edits };
}

/**
 * Links in `text` that resolve to `targetRel`, for backlink reporting.
 * Returns one entry per occurrence, with 1-based line numbers.
 */
export function findLinksTo(
  text: string,
  targetRel: string,
  index: LinkIndex
): Array<{ line: number; link: string; context: string }> {
  const hits: Array<{ line: number; link: string; context: string }> = [];
  const links = parseLinks(text);
  if (links.length === 0) return hits;

  // Precompute line starts once so line numbers cost no extra scanning per link.
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  for (const link of links) {
    if (index.resolve(link.target) !== targetRel) continue;
    const lineIdx = lineOf(link.index);
    const lineEnd = lineIdx + 1 < lineStarts.length ? lineStarts[lineIdx + 1] - 1 : text.length;
    hits.push({
      line: lineIdx + 1,
      link: link.raw,
      context: text.slice(lineStarts[lineIdx], lineEnd).trim().slice(0, 200),
    });
  }
  return hits;
}
