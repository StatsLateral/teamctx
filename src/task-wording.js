/**
 * What makes a proposed task one a person picks up (#175).
 *
 * The distiller is asked for tasks a person would pick up and finish. Given a
 * brief whose rules describe a workflow, it has proposed the workflow's steps
 * instead, worded for an assistant. This is the check on what comes back. It is
 * narrow on purpose: it catches a title that is clearly not a person's task,
 * never one that is merely worded differently.
 */

/**
 * Words that only make sense said to an assistant. Not "the agent" or "the
 * model": a person's task can be about an agent or a model ("Call the agent at
 * Acme").
 */
const ADDRESSES_ASSISTANT = /\b(?:you|your|yours|yourself|claude|chatgpt|gpt|llm)\b|\bthe (?:ai|assistant)\b/i;

/** A first word that cannot be what somebody does. */
const NOT_A_DOING_WORD = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its', 'we', 'i', 'they', 'he', 'she', 'our', 'my', 'their']);

/**
 * Doing words that happen to end in -ing, and what follows any other -ing word
 * when it is a step being described ("Reviewing the draft") rather than a thing
 * being named ("Pricing page copy").
 */
const ING_VERBS = new Set(['bring', 'ping', 'ring', 'sing', 'string', 'spring', 'swing', 'sting', 'cling', 'fling', 'sling', 'wring']);
const STEP_AFTER_ING = new Set(['the', 'a', 'an', 'each', 'every', 'all', 'any', 'this', 'that', 'these', 'those', 'it', 'them', 'our', 'their', 'whether']);

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
  if (NOT_A_DOING_WORD.has(first) || /^\d/.test(first) || (first.endsWith('ing') && !ING_VERBS.has(first) && STEP_AFTER_ING.has(w[1].toLowerCase()))) {
    return 'it does not start with what a person does';
  }
  if (w.slice(1).every(x => NOT_A_THING.has(x.toLowerCase()))) return 'it does not name the thing to do';
  return null;
}

/**
 * Whether the input itself says not to make tasks: it is only source material,
 * or it says so in as many words. That is the person's instruction, so it holds
 * whatever the model proposed.
 */
const NO_TASKS = /\b(?:(?:do not|don't|dont|no need to|never) (?:create|add|make|propose|generate|suggest) (?:any )?tasks|(?:create|add|make|propose|generate|suggest) no tasks|no tasks (?:needed|please|for this|from this)|(?:only|just|purely) (?:as )?source material|source material only|is source material)\b/i;

export function saysNoTasks(text) {
  return NO_TASKS.test(String(text ?? ''));
}

/**
 * Each proposed task with the wording of the decision or rule it came from
 * beside it (`fromRecord`), so a manager sees why it is proposed. `from` is an
 * existing record's id, or the `ref` of a record proposed with it; one that names
 * neither a decision nor a rule is dropped, and the task kept.
 */
export function withWhereFrom(operations, records) {
  const proposed = new Map(operations.filter(o => o?.type === 'addRecord' && o.ref).map(o => [o.ref, o.record]));
  return operations.map(op => {
    if (op?.type !== 'addTask' || op.from == null) return op;
    const { from, fromRecord: _ignored, ...task } = op;
    const record = proposed.get(from) || records.find(r => r.id === from);
    if (!['decision', 'rule'].includes(record?.type) || typeof record.text !== 'string') return task;
    return { ...task, from, fromRecord: { type: record.type, text: record.text } };
  });
}

/**
 * A task that names, as where it came from, a record that was then dropped (an
 * invalid replacement, say) says nothing instead: the reviewer would otherwise
 * read "from Decision: …" about a decision that is not being added.
 */
export function withoutDroppedSources(kept, droppedOps) {
  const gone = new Set(droppedOps.filter(o => o?.type === 'addRecord' && o.ref).map(o => o.ref));
  if (!gone.size) return kept;
  return kept.map(op => {
    if (op?.type !== 'addTask' || !gone.has(op.from)) return op;
    const { from: _from, fromRecord: _fromRecord, ...task } = op;
    return task;
  });
}

/**
 * The model's operations without the tasks a person would not pick up, and
 * without any task at all when the input says not to make them. `at` maps each
 * old position to its new one, or to -1 for one that was dropped, so a
 * contradiction that points at an operation by index still points at the same
 * one. `dropped` names each task left out and why, so one that was real work
 * can be added by hand.
 */
export function keepPeoplesTasks(operations, input) {
  const none = saysNoTasks(input);
  const kept = [];
  const at = new Map();
  const dropped = [];
  operations.forEach((op, i) => {
    const problem = op?.type === 'addTask' && (none ? 'the input says not to make tasks' : taskTitleProblem(op.title));
    if (problem) {
      at.set(i, -1);
      dropped.push({ reason: `left out the task "${String(op.title ?? '').trim()}": ${problem}` });
      return;
    }
    at.set(i, kept.length);
    kept.push(op);
  });
  return { operations: kept, at, dropped };
}
