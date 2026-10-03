/**
 * YAML frontmatter: reading, and minimally-invasive editing.
 *
 * Reading goes through the `yaml` package so every legal YAML shape is
 * understood. Editing is deliberately line-based instead of
 * parse-then-reserialize: re-emitting the whole block would reformat keys the
 * server never touched (quoting, comments, key order, Excalidraw plugin keys),
 * and in a live-synced vault that churn lands on every device. Only the lines
 * belonging to the key being changed are replaced; every other byte of the
 * note is preserved.
 */
import { parse as parseYaml } from 'yaml';

export interface FrontmatterSplit {
  /** True when the note starts with a closed `---` block. */
  present: boolean;
  /** Lines between the fences (no fence lines, no line endings). */
  lines: string[];
  /** Everything after the closing fence, verbatim. */
  body: string;
  /** Line ending the note uses, so edits do not mix CRLF and LF. */
  eol: string;
  /** Offset in the original text where `body` starts (0 when absent). */
  bodyOffset: number;
}

const OPEN = /^---[ \t]*\r?\n/;

export function splitFrontmatter(text: string): FrontmatterSplit {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const open = OPEN.exec(text);
  if (!open) return { present: false, lines: [], body: text, eol, bodyOffset: 0 };

  let cursor = open[0].length;
  const lines: string[] = [];
  while (cursor <= text.length) {
    const nl = text.indexOf('\n', cursor);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(cursor, end).replace(/\r$/, '');
    const next = nl === -1 ? text.length : nl + 1;
    if (line === '---' || line === '...') {
      return { present: true, lines, body: text.slice(next), eol, bodyOffset: next };
    }
    lines.push(line);
    if (nl === -1) break;
    cursor = next;
  }
  // An unclosed fence is not frontmatter (Obsidian treats it as body text).
  return { present: false, lines: [], body: text, eol, bodyOffset: 0 };
}

/** Parse the block into a plain object, or null when it is not valid YAML. */
export function parseFrontmatter(split: FrontmatterSplit): Record<string, unknown> | null {
  if (!split.present) return {};
  if (split.lines.length === 0) return {};
  try {
    const value = parseYaml(split.lines.join('\n'), { prettyErrors: false });
    if (value === null || value === undefined) return {};
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Index range [start, end) of a top-level key and its continuation lines. */
function keyRange(lines: string[], key: string): [number, number] | null {
  const head = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*:`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return null;
  let end = start + 1;
  // Continuation: indented lines and block-sequence items (`- x`, which YAML
  // allows at column 0 under a key). A blank line ends the value.
  while (end < lines.length && /^([ \t]+\S|-([ \t]|$))/.test(lines[end])) end += 1;
  return [start, end];
}

/** Return lines with `key` set to the given rendered lines (replacing or appending). */
export function setKey(lines: string[], key: string, rendered: string[]): string[] {
  const range = keyRange(lines, key);
  const out = [...lines];
  if (range) {
    out.splice(range[0], range[1] - range[0], ...rendered);
  } else {
    out.push(...rendered);
  }
  return out;
}

export function removeKey(lines: string[], key: string): string[] {
  const range = keyRange(lines, key);
  if (!range) return lines;
  const out = [...lines];
  out.splice(range[0], range[1] - range[0]);
  return out;
}

/** True when the key's current value is written as a block sequence (`- a`). */
export function isBlockList(lines: string[], key: string): boolean {
  const range = keyRange(lines, key);
  if (!range) return false;
  return range[1] - range[0] > 1 && /^[ \t]*-/.test(lines[range[0] + 1]);
}

/** Reassemble a note from (possibly new) frontmatter lines and the original body. */
export function joinFrontmatter(split: FrontmatterSplit, lines: string[]): string {
  const { eol } = split;
  if (lines.length === 0 && !split.present) return split.body;
  const block = `---${eol}${lines.map((l) => `${l}${eol}`).join('')}---${eol}`;
  return block + split.body;
}

/** Quote a scalar only when YAML would otherwise misread it. */
export function yamlScalar(value: string): string {
  if (/^[\p{L}\p{N}_][\p{L}\p{N}_\-/.]*$/u.test(value) && !/^(true|false|null|yes|no|on|off|~)$/i.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}
