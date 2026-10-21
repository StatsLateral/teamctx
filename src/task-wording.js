/**
 * What makes a proposed task one a person picks up (#175).
 *
 * The distiller is asked for tasks a person would pick up and finish. Given a
 * brief whose rules describe a workflow, it has proposed the workflow's steps
 * instead, worded for an assistant. This is the check on what comes back. It is
 * narrow on purpose: it catches a title that is clearly not a person's task,
 * never one that is merely worded differently.
 */

/** Words that only make sense said to an assistant. */
const ADDRESSES_ASSISTANT = /\b(?:you|your|yours|yourself|claude|chatgpt|gpt|llm)\b|\bthe (?:ai|assistant|model|bot|agent)\b/i;

/** A first word that cannot be what somebody does. */
const NOT_A_DOING_WORD = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its', 'we', 'i', 'they', 'he', 'she', 'our', 'my', 'their']);

/** Doing words that happen to end in -ing. */
const ING_VERBS = new Set(['bring', 'ping', 'ring', 'sing', 'string', 'spring', 'swing', 'sting', 'cling', 'fling', 'sling', 'wring']);

/** What a title can end on and still not say what the work is about. */
const NOT_A_THING = new Set(['it', 'this', 'that', 'them', 'these', 'those']);

const words = (s) => s.replace(/[^\p{L}\p{N}'\s-]/gu, ' ').split(/\s+/).filter(Boolean);

/** Why `title` is not a task a person picks up, or `null` when it is. */
export function taskTitleProblem(title) {
  const text = String(title ?? '').trim();
  if (ADDRESSES_ASSISTANT.test(text)) return 'it is addressed to an assistant';
  const w = words(text);
  if (w.length < 2) return 'it does not name the thing to do';
  const first = w[0].toLowerCase();
  if (NOT_A_DOING_WORD.has(first) || /^\d/.test(first) || (first.endsWith('ing') && !ING_VERBS.has(first))) {
    return 'it does not start with what a person does';
  }
  if (w.slice(1).every(x => NOT_A_THING.has(x.toLowerCase()))) return 'it does not name the thing to do';
  return null;
}
