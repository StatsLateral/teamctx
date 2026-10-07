import Ajv from 'ajv';

// The MVP governs four kinds of thing: what the team decided, what it is
// assuming, the rules it works by, and the exceptions it allows. The reason
// behind any of them is its `detail`, not a record of its own.
export const RECORD_TYPES = ['decision', 'assumption', 'rule', 'exception'];
export const STATUSES = ['active', 'replaced', 'broken', 'closed'];
export const LABELS = {
  decision: 'We decided:', assumption: "We're assuming:", rule: 'Rule:', exception: 'Allowed:',
};

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const PERSON = { type: 'object', required: ['name'], properties: { key: { type: ['string', 'null'] }, name: { type: 'string' } } };
const IDS = { type: 'array', items: { type: 'string' } };

const recordSchema = {
  type: 'object',
  required: ['id', 'type', 'text', 'status', 'attachedTo', 'links'],
  properties: {
    id: { type: 'string', minLength: 1 },
    type: { enum: RECORD_TYPES },
    text: { type: 'string', minLength: 1 },
    detail: { type: 'string' },
    status: { enum: STATUSES },
    owner: { anyOf: [PERSON, { type: 'null' }] },
    attachedTo: {
      type: 'object', required: ['kind'],
      properties: { kind: { enum: ['project', 'workstream', 'task'] }, id: { type: 'string' } },
    },
    reviewBy: DATE,
    expiresAt: DATE,
    links: {
      type: 'object',
      properties: {
        restsOn: IDS,
        bends: { type: ['string', 'null'] },
        replaces: { type: ['string', 'null'] },
        answers: { type: ['string', 'null'] },
      },
    },
    sourceContributionIds: IDS,
    // Added only through review, by `addEvidence`. The text is a quote; who,
    // where from and when come from the contribution, never from the model.
    evidence: {
      type: 'array',
      items: {
        type: 'object', required: ['text'],
        properties: {
          text: { type: 'string', minLength: 1 },
          source: { type: ['string', 'null'] }, at: { type: ['string', 'null'] }, by: { type: ['string', 'null'] },
        },
      },
    },
  },
  allOf: [
    { if: { properties: { type: { const: 'assumption' } } }, then: { required: ['owner', 'reviewBy'], properties: { owner: PERSON } } },
    { if: { properties: { type: { const: 'exception' } } }, then: { required: ['expiresAt'], properties: { links: { type: 'object', required: ['bends'], properties: { bends: { type: 'string', minLength: 1 } } } } } },
  ],
};

const ajv = new Ajv({ allErrors: true });
const checkRecord = ajv.compile(recordSchema);

/** `{ ok, errors }`, where each error names the field, so a refusal can say what to fill in. */
export function validateRecord(record) {
  const ok = checkRecord(record);
  if (ok) return { ok: true, errors: [] };
  const errors = (checkRecord.errors || []).map(e => {
    const field = e.params?.missingProperty || e.instancePath.replace(/^\//, '').replace(/\//g, '.') || 'record';
    return `${field}: ${e.message}`;
  });
  return { ok: false, errors: [...new Set(errors)] };
}

export const today = () => new Date().toISOString().slice(0, 10);

export function isExpired(record, onDay = today()) {
  return !!record?.expiresAt && record.expiresAt < onDay;
}

export function isActive(record, onDay = today()) {
  return record?.status === 'active' && !isExpired(record, onDay);
}

export function emptyProject(name = '') {
  return { name, goal: null, records: [], tasks: [] };
}

export function emptyWorkstream(id, name = '') {
  return { id, name, records: [], tasks: [] };
}

export class LegacyFormatError extends Error {
  constructor() {
    super('This project uses the old Why/What/How format, which teamctx no longer reads. Remove the .teamctx folder, then run `teamctx init` to start it in the new format.');
    this.code = 'LEGACY_FORMAT';
  }
}

/** Every tree read passes through here, so the old shape is reported rather than read as empty. */
export function assertCurrentFormat(tree) {
  if (tree && Object.prototype.hasOwnProperty.call(tree, 'whys')) throw new LegacyFormatError();
  return tree;
}

// ---- Structure (config.workstreams is the registry) ----

function entries(config) {
  const list = (config?.workstreams || []).filter(w => w?.id);
  const ids = new Set(list.map(w => w.id));
  // A parent that is the entry itself or does not exist makes the entry a root:
  // a broken registry must still number and walk, never loop.
  return list.map(w => ({ ...w, parent: w.parent && w.parent !== w.id && ids.has(w.parent) ? w.parent : null }));
}

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id));

export function workstreamTree(config) {
  const list = entries(config);
  const build = (parent, seen) => list
    .filter(w => w.parent === parent && !seen.has(w.id))
    .sort(byOrder)
    .map(w => ({ id: w.id, name: w.name || w.id, parent: w.parent, order: w.order ?? 0, children: build(w.id, new Set([...seen, w.id])) }));
  return build(null, new Set());
}

export function ancestorsOf(config, id) {
  const list = entries(config);
  const out = [];
  let cur = list.find(w => w.id === id)?.parent || null;
  while (cur && !out.includes(cur) && cur !== id) {
    out.unshift(cur);
    cur = list.find(w => w.id === cur)?.parent || null;
  }
  return out;
}

export function descendantsOf(config, id) {
  const out = [];
  const walk = (nodes) => { for (const n of nodes) { out.push(n.id); walk(n.children); } };
  const find = (nodes) => { for (const n of nodes) { if (n.id === id) return n; const f = find(n.children); if (f) return f; } return null; };
  const node = find(workstreamTree(config));
  if (node) walk(node.children);
  return out;
}

/**
 * Each workstream's number, as stored when it was added (see src/numbering.js).
 * Flat across the project and never derived from position, so a number said in
 * a meeting still means the same part next week. Nesting is for the reader's
 * eyes only: `depthOf` says how far to indent.
 */
export function numberWorkstreams(config) {
  const out = new Map();
  for (const w of entries(config)) if (Number.isSafeInteger(w.number) && w.number > 0) out.set(w.id, String(w.number));
  return out;
}

/** How many parts sit above this one, for indenting a list. */
export function depthOf(config, id) {
  return ancestorsOf(config, id).length;
}
