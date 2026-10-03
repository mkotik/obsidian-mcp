/**
 * Obsidian tags: extraction, normalisation, matching.
 *
 * Obsidian reads tags from two places, and so does this module:
 *  - frontmatter `tags:` (or legacy `tag:`), as a YAML list or a comma/space
 *    separated string, with or without a leading `#`
 *  - inline `#tag` in the body, outside code blocks and inline code
 *
 * Tags are case-insensitive in Obsidian (`#Project` and `#project` are the
 * same tag), so comparisons use the lowercased form while the display form of
 * the first occurrence is kept for output. Nested tags (`project/alpha`) match
 * a filter on their parent (`project`).
 */

/** Characters Obsidian allows in a tag body. */
const TAG_BODY = /^[\p{L}\p{N}_\-/]+$/u;
const INLINE_TAG = /(^|[\s(\[{,;])#([\p{L}\p{N}_\-/]+)/gu;

export const MAX_TAG_CHARS = 64;

/**
 * Normalise user/LLM input into a valid tag, or null when it cannot be one.
 * Strips `#`, trims, turns internal whitespace into `-`, collapses slashes.
 */
export function normalizeTag(input: string): string | null {
  let t = input.trim().replace(/^#+/, '').trim();
  t = t.replace(/\s+/g, '-').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (t.length === 0 || t.length > MAX_TAG_CHARS) return null;
  if (!TAG_BODY.test(t)) return null;
  if (/^[0-9/]+$/.test(t)) return null; // Obsidian requires a non-numeric character
  return t;
}

/** Tags declared in parsed frontmatter, in declaration order. */
export function frontmatterTags(fm: Record<string, unknown> | null): string[] {
  if (!fm) return [];
  const raw = fm.tags ?? fm.tag;
  const items: string[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) if (typeof v === 'string' || typeof v === 'number') items.push(String(v));
  } else if (typeof raw === 'string') {
    items.push(...raw.split(/[,\s]+/));
  }
  const out: string[] = [];
  for (const item of items) {
    const t = normalizeTag(item);
    if (t) out.push(t);
  }
  return dedupe(out);
}

/** Remove fenced code blocks and inline code so `#` inside code is ignored. */
function stripCode(body: string): string {
  return body
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/%%[\s\S]*?%%/g, ''); // Obsidian comments
}

/** Inline `#tags` found in the note body. */
export function inlineTags(body: string): string[] {
  const out: string[] = [];
  for (const m of stripCode(body).matchAll(INLINE_TAG)) {
    const t = normalizeTag(m[2]);
    if (t) out.push(t);
  }
  return dedupe(out);
}

/** Case-insensitive de-duplication that keeps the first display form. */
export function dedupe(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** True when `tag` equals `filter` or is nested beneath it (case-insensitive). */
export function tagMatches(tag: string, filter: string): boolean {
  const t = tag.toLowerCase();
  const f = filter.toLowerCase();
  return t === f || t.startsWith(`${f}/`);
}

/** True when the note carries every tag in `filters` (each may match a nested child). */
export function hasAllTags(noteTags: readonly string[], filters: readonly string[]): boolean {
  return filters.every((f) => noteTags.some((t) => tagMatches(t, f)));
}
