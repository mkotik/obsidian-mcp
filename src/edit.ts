/**
 * Frontmatter mutations the server performs on a note's behalf: date stamping
 * and tag edits. Both go through the line-based editor in frontmatter.ts, so
 * keys the server does not own are left byte-identical.
 */
import { splitFrontmatter, parseFrontmatter, setKey, removeKey, isBlockList, joinFrontmatter, yamlScalar } from './frontmatter.js';
import { frontmatterTags, dedupe } from './tags.js';
import { parseNoteDate, formatDate, formatDateTime } from './notes.js';

export interface StampOptions {
  nowMs: number;
  /** Creation time to record when the note has no `created:` yet. */
  createdMs: number;
  timeZone: string;
}

export interface StampResult {
  text: string;
  /** Keys written, e.g. ['created', 'updated']. Empty when nothing changed. */
  stamped: string[];
  /** Why stamping was skipped, when it was. */
  skipped?: 'invalid_frontmatter';
}

/** Format `ms` the way an existing value was written (date-only vs date-time). */
function formatLike(existing: unknown, ms: number, timeZone: string): string {
  if (typeof existing === 'string' && /\d{2}:\d{2}/.test(existing)) return formatDateTime(ms, timeZone);
  return formatDate(ms, timeZone);
}

/**
 * Ensure the note carries `created:` and a current `updated:`.
 *
 *  - `created` is only ever added, never changed: an existing value — even one
 *    the server cannot parse — is the user's and stays.
 *  - `updated` (or `modified`, if that is the key the note already uses) is
 *    refreshed when it holds a real date, and added when absent. A placeholder
 *    such as `YYYY-MM-DD` in a template is left alone.
 *  - A note whose frontmatter is not valid YAML is not touched at all.
 *
 * New values are date-only (`YYYY-MM-DD`), the vault's existing convention.
 */
export function stampDates(text: string, opts: StampOptions): StampResult {
  const split = splitFrontmatter(text);
  const fm = parseFrontmatter(split);
  if (fm === null) return { text, stamped: [], skipped: 'invalid_frontmatter' };

  let lines = split.lines;
  const stamped: string[] = [];

  if (!('created' in fm)) {
    lines = setKey(lines, 'created', [`created: ${formatDate(opts.createdMs, opts.timeZone)}`]);
    stamped.push('created');
  }

  const key = 'updated' in fm || !('modified' in fm) ? 'updated' : 'modified';
  const current = fm[key];
  const parseable = current === undefined || parseNoteDate(current, opts.timeZone) !== null || current instanceof Date;
  if (parseable) {
    const value = formatLike(current, opts.nowMs, opts.timeZone);
    if (String(current ?? '') !== value) {
      lines = setKey(lines, key, [`${key}: ${value}`]);
      stamped.push(key);
    }
  }

  if (stamped.length === 0) return { text, stamped };
  return { text: joinFrontmatter(split, lines), stamped };
}

export interface TagEditResult {
  text: string;
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
  changed: boolean;
}

/**
 * Add and/or remove frontmatter tags. Only the frontmatter `tags:` list is
 * edited; inline `#tags` in the body are never rewritten (that would mean
 * editing prose), so removing a tag that also appears inline is reported back
 * to the caller rather than silently half-done.
 *
 * Output style follows the note: a block list (`- a`) stays a block list,
 * otherwise the vault's flow style `tags: [a, b]` is used. A legacy `tag:`
 * key is folded into `tags:`.
 */
export function editTags(text: string, add: readonly string[], remove: readonly string[]): TagEditResult | { error: string } {
  const split = splitFrontmatter(text);
  const fm = parseFrontmatter(split);
  if (fm === null) return { error: 'the note has frontmatter that is not valid YAML; fix it before editing tags' };

  const before = frontmatterTags(fm);
  const removeKeys = new Set(remove.map((t) => t.toLowerCase()));
  const kept = before.filter((t) => !removeKeys.has(t.toLowerCase()));
  const after = dedupe([...kept, ...add]);

  const beforeKeys = new Set(before.map((t) => t.toLowerCase()));
  const afterKeys = new Set(after.map((t) => t.toLowerCase()));
  const added = after.filter((t) => !beforeKeys.has(t.toLowerCase()));
  const removed = before.filter((t) => !afterKeys.has(t.toLowerCase()));
  const changed = added.length > 0 || removed.length > 0;
  if (!changed) return { text, before, after, added, removed, changed };

  const block = isBlockList(split.lines, 'tags') || (!('tags' in fm) && isBlockList(split.lines, 'tag'));
  let lines = removeKey(split.lines, 'tag');
  if (after.length === 0) {
    lines = removeKey(lines, 'tags');
  } else if (block) {
    lines = setKey(lines, 'tags', ['tags:', ...after.map((t) => `  - ${yamlScalar(t)}`)]);
  } else {
    lines = setKey(lines, 'tags', [`tags: [${after.map(yamlScalar).join(', ')}]`]);
  }
  return { text: joinFrontmatter(split, lines), before, after, added, removed, changed };
}
