/**
 * How a task output changed from the version it is based on (#253).
 *
 * Outputs are append-only: a changed deliverable is not an edit of the old
 * record but a new output whose `basedOn` points at the earlier one. This turns
 * that stated lineage into something the drawer can show — and, when an output
 * and its parent are both readable plain text, a bounded line diff of what
 * actually changed.
 *
 * Pure and mechanical: no AI, no network. The diff itself comes from a
 * maintained library (`diff`), never a hand-rolled one. The caller resolves the
 * text of a file output (it must read the bytes); the bodies of text outputs are
 * already in hand. Binary, office and link outputs have no text to compare and
 * get lineage only — never a guessed or partial diff.
 */
import { diffLines } from 'diff';
import { isReadableTextType } from './file-output.js';

/** Match the output text limit: beyond this a diff is summarised, not shown. */
export const MAX_DIFF_CHARS = 50000;
/** How many changed lines the inline preview carries before it says "truncated". */
export const MAX_HUNK_LINES = 60;

/** Whether an output's own content can be read as text for a diff. */
export function isDiffableText(output) {
  if (!output) return false;
  const kind = output.kind || 'text';
  if (kind === 'text') return true;
  if (kind === 'file') return isReadableTextType(output.file?.name || '');
  return false; // link outputs carry no bytes
}

/**
 * A bounded line diff of two texts. Returns line counts always, and a capped
 * preview of the changed lines (`+`/`-`, `···` between separated
 * runs). `unchanged` when identical; `tooLarge` when either side is over the
 * limit, so the page shows counts, never a misleading partial diff. `null` when
 * a side is missing.
 */
export function diffTexts(before, after, { maxChars = MAX_DIFF_CHARS, maxHunkLines = MAX_HUNK_LINES } = {}) {
  if (typeof before !== 'string' || typeof after !== 'string') return null;
  if (before.length > maxChars || after.length > maxChars) {
    return { tooLarge: true, added: null, removed: null, hunks: [], truncated: true };
  }
  // A final line without a trailing newline is a different token to the same
  // line with one, which `diffLines` would report as a spurious change. Give
  // both sides a trailing newline so only real line changes show.
  const norm = (s) => (s === '' || s.endsWith('\n') ? s : `${s}\n`);
  const nb = norm(before);
  const na = norm(after);
  if (nb === na) return { unchanged: true, added: 0, removed: 0, hunks: [], truncated: false };

  const parts = diffLines(nb, na);
  let added = 0;
  let removed = 0;
  let truncated = false;
  let gap = false;
  const hunks = [];
  for (const p of parts) {
    if (!p.added && !p.removed) { if (hunks.length) gap = true; continue; }
    const lines = p.value.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop(); // the trailing newline is not a line
    for (const line of lines) {
      if (p.added) added += 1; else removed += 1;
      if (hunks.length >= maxHunkLines) { truncated = true; continue; }
      if (gap) { hunks.push('···'); gap = false; }
      hunks.push((p.added ? '+ ' : '- ') + line);
    }
  }
  return { added, removed, hunks, truncated };
}

/**
 * For each output that is based on another, how it compares to that parent.
 * Keyed by output id. `readFileText(output) -> string | null` reads a readable
 * text *file* output's content (the caller owns the byte read and the scope it
 * runs under); text outputs are compared from their `body` without a read.
 *
 * An output whose parent is gone, or where either side has no diffable text, is
 * reported as `diffable: false` with a reason — the chain line still shows, but
 * there is no diff to render.
 */
export async function diffsForOutputs(outputs, readFileText = async () => null, opts = {}) {
  const list = Array.isArray(outputs) ? outputs : [];
  const byId = new Map(list.filter(o => o && o.id).map(o => [o.id, o]));
  const textOf = async (o) => {
    const kind = o.kind || 'text';
    if (kind === 'text') return typeof o.body === 'string' ? o.body : null;
    if (kind === 'file' && isReadableTextType(o.file?.name || '')) return await readFileText(o);
    return null;
  };
  const noText = (o) => {
    const kind = o.kind || 'text';
    if (kind === 'link') return 'a linked file has no stored text to compare';
    if (kind === 'file') return isReadableTextType(o.file?.name || '')
      ? 'its text could not be read here'
      : `no text diff for a ${o.file?.name ? o.file.name.split('.').pop() : 'binary'} file`;
    return 'no text to compare';
  };

  const out = {};
  for (const o of list) {
    if (!o || !o.basedOn) continue;
    const parent = byId.get(o.basedOn);
    const fact = { basedOn: o.basedOn, basedOnTitle: parent ? (parent.title || null) : null };
    if (!parent) { out[o.id] = { ...fact, diffable: false, reason: 'the earlier version is no longer listed' }; continue; }
    const [a, b] = [await textOf(parent), await textOf(o)];
    if (a == null || b == null) {
      out[o.id] = { ...fact, diffable: false, reason: noText(a == null ? parent : o) };
      continue;
    }
    out[o.id] = { ...fact, diffable: true, ...diffTexts(a, b, opts) };
  }
  return out;
}
