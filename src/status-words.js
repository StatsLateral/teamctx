/**
 * Words that say how far some work has got: approved, final, closed, done.
 *
 * Only a person's decision makes those true. An AI summarising a contribution
 * must not introduce them (a draft sent "for review" came back as "accepted as
 * the settled content" and "closed"), and must not write them onto a task's
 * title to record progress. Kept in one place so the two checks agree.
 */
const WORDS = 'approved|accepted|settled|final(?:i[sz]ed)?|closed|complete(?:d)?|done|finished|published|signed[- ]off|ready (?:for|to) (?:publish|ship|send|go)';
export const STATUS_WORDS = new RegExp(`\\b(?:${WORDS})\\b`, 'gi');

/** The status words in `text`, lowercased. */
export function statusWordsIn(text) {
  return [...String(text ?? '').matchAll(STATUS_WORDS)].map(m => m[0].toLowerCase().replace(/\s+/g, ' '));
}
