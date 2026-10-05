/**
 * A handle a person can say out loud, and find again tomorrow.
 *
 * A task's id is `task-1a2b3c4d` and has never been shown to anybody. What is
 * shown is a position worked out at render time — `1.2`, `3` — so the number
 * against a thing changes the moment something is added above it. The task
 * somebody wrote down this morning is a different number this afternoon, and a
 * record quoted in a meeting cannot be looked up after it.
 *
 * So the key is stored rather than derived, minted once and never reused. The
 * random id stays the internal identity; this is the handle. `T-14` is a task,
 * and records are typed: `D` decision, `R` rule, `A` assumption, `X` exception.
 *
 * The letters are the first letter of each word except exception, which would
 * collide with nothing but reads badly as `E` beside the others — `X` is what
 * the spec settled on and what a reader will see as "the odd one out", which an
 * exception is.
 */

/** The letter each kind of thing carries. Tasks are not records, hence `task`. */
export const KEY_PREFIX = {
  task: 'T', decision: 'D', rule: 'R', assumption: 'A', exception: 'X',
};

export const KEY_PREFIXES = ['T', 'D', 'R', 'A', 'X'];

/** `T-14` and nothing else. Deliberately not `t-14`: a key is quoted, not typed loosely. */
const KEY = /^([TDRAX])-([1-9]\d*)$/;

/** What a project with no counters yet starts from. */
export const emptyCounters = () => Object.fromEntries(KEY_PREFIXES.map(p => [p, 1]));

export function isKey(value) {
  return typeof value === 'string' && KEY.test(value);
}

/** `{ prefix, n }`, or null. Used to resolve a link alias and to resume counters. */
export function parseKey(value) {
  const m = KEY.exec(typeof value === 'string' ? value : '');
  return m ? { prefix: m[1], n: Number(m[2]) } : null;
}

/**
 * The next key for a kind, and the counters to store.
 *
 * Returns rather than mutates, because the counters live in `config.json` while
 * the thing being keyed is written to a tree. The caller writes both or neither
 * — see `applyOps`, where a contribution that ends up queued throws its tree
 * away and must throw the counters away with it, or a key is burned by a
 * contribution that may never land.
 */
export function mintKey(counters, kind) {
  const prefix = KEY_PREFIX[kind];
  if (!prefix) return { key: null, counters: counters || emptyCounters() };
  const current = { ...emptyCounters(), ...(counters || {}) };
  const n = Number.isInteger(current[prefix]) && current[prefix] > 0 ? current[prefix] : 1;
  return { key: `${prefix}-${n}`, counters: { ...current, [prefix]: n + 1 } };
}

/**
 * Counters that sit above every key already in use.
 *
 * Read off the keys themselves rather than counted, which is what keeps a key
 * from being reused after a delete: three tasks created and one removed leaves
 * `T-1` and `T-3`, and a counter derived from the count would mint `T-3` again.
 */
export function countersAbove(keys) {
  const out = emptyCounters();
  for (const k of keys || []) {
    const parsed = parseKey(k);
    if (parsed && parsed.n + 1 > out[parsed.prefix]) out[parsed.prefix] = parsed.n + 1;
  }
  return out;
}

/**
 * Creation order, for assigning keys to things written before keys existed.
 *
 * `createdAt` is a date, so most records in a project share one. The first
 * contribution id breaks the tie because those carry a timestamp
 * (`c-<millis>-<rand>`), and position in the file breaks what is left. Nothing
 * here is a guess: it is the most specific thing available, then the next.
 */
export function inCreationOrder(items) {
  const timestamp = (item) => {
    if (String(item.createdAt || '').includes('T')) {
      const instant = Date.parse(item.createdAt);
      if (Number.isFinite(instant)) return instant;
    }
    const match = /^(?:c|mcp)-(\d+)-/.exec(item.sourceContributionIds?.[0] || '');
    return match ? Number(match[1]) : 0;
  };
  return (items || [])
    .map((item, at) => ({ item, at }))
    .sort((a, b) => String(a.item.createdAt || '').slice(0, 10).localeCompare(String(b.item.createdAt || '').slice(0, 10))
      || timestamp(a.item) - timestamp(b.item)
      || a.at - b.at)
    .map(({ item }) => item);
}

/** Number all trees together, preserving issued keys and counters after deletes. */
export function backfillKeys(trees, nextKey) {
  const copies = trees.map(tree => ({ ...tree,
    records: (tree.records || []).map(r => ({ ...r })),
    tasks: (tree.tasks || []).map(t => ({ ...t })),
  }));
  const items = copies.flatMap(t => [...t.records, ...t.tasks]);
  let counters = countersAbove(items.map(x => x.key));
  for (const prefix of KEY_PREFIXES) {
    if (Number.isSafeInteger(nextKey?.[prefix])) counters[prefix] = Math.max(counters[prefix], nextKey[prefix]);
  }
  for (const item of inCreationOrder(items)) {
    if (item.key) continue;
    const minted = mintKey(counters, item.type || 'task');
    if (!minted.key) continue;
    item.key = minted.key;
    counters = minted.counters;
  }
  return { trees: copies, nextKey: counters };
}

/**
 * The internal id a key names, or the value unchanged.
 *
 * Links keep carrying the internal id, which is what never changes and what the
 * tools hand back. But the key is what a person has in front of them — on the
 * page, in a prompt, in something somebody pasted into a chat — so `?task=T-14`
 * has to reach the same row as `?task=task-1a2b3c4d`.
 *
 * A value that is not a key is returned untouched, because most of them are ids
 * and this sits in front of every link. A key naming nothing is also returned
 * untouched: it then resolves to no row, which is the same quiet fallback an
 * unknown id already gets rather than an error about a thing that is not there.
 */
export function resolveKey(value, { records = [], tasks = [] } = {}) {
  if (!isKey(value)) return value;
  const found = [...records, ...tasks].find(x => x?.key === value);
  return found?.id ?? value;
}
