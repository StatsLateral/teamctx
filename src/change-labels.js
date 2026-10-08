import { LABELS } from './model.js';
import { evidenceLabel } from './contradictions.js';

// Shared by the web view and by what an assistant is told to read back, so a
// manager hears the same words in their chat that they see on the page.
/** One operation of a proposal, in the words a manager would use. */
export function describeChange(op, tree) {
  const text = (id) => (tree?.records || []).find(r => r.id === id)?.text;
  const task = (id) => (tree?.tasks || []).find(t => t.id === id)?.title;
  switch (op?.type) {
    case 'setGoal': return `Set the goal: ${op.text}`;
    case 'addRecord': return `Add: ${LABELS[op.record?.type] || 'Note:'} ${op.record?.text}`;
    case 'editRecord': return `Reword ${text(op.id) ? `"${text(op.id)}"` : 'a record'}${op.changes?.text ? ` to: ${op.changes.text}` : ''}`;
    case 'setRecordStatus': return `Mark ${text(op.id) ? `"${text(op.id)}"` : 'a record'} as ${op.status}`;
    case 'addEvidence': return evidenceLabel(op);
    case 'addTask': return `Add a task: ${op.title}`;
    case 'editTask': return `Retitle ${task(op.id) ? `"${task(op.id)}"` : 'a task'} to: ${op.title}`;
    case 'removeTask': return `Remove the task ${task(op.id) ? `"${task(op.id)}"` : ''}`.trim();
    default: return null;
  }
}

/**
 * Text somebody else wrote, made safe to place inside a sentence that tells an
 * assistant what to do: one line, bounded, and quoted so it reads as the thing
 * to show the person rather than as part of the instruction.
 */
export function asQuotedData(text, max = 240) {
  const flat = String(text ?? '')
    // Control and invisible formatting characters (zero-width, bidi overrides) can hide where a quote ends.
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    // Anything that could pass for a closing quote, or open a code span, becomes a plain apostrophe.
    .replace(/["\u201c\u201d\u201e\u201f\u2033\u2036\u00ab\u00bb\u300c-\u300f\uff02`\\]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return `"${flat.length > max ? `${flat.slice(0, max)}…` : flat}"`;
}
