import { randomBytes } from 'crypto';
import { validateRecord, today } from './model.js';

export const OP_TYPES = ['setGoal', 'addRecord', 'editRecord', 'setRecordStatus', 'addTask', 'editTask', 'removeTask'];
const STATUS_TARGETS = ['replaced', 'broken', 'closed', 'active'];
const EDITABLE = ['text', 'detail', 'owner', 'reviewBy', 'expiresAt', 'links', 'attachedTo'];

const mint = (prefix) => `${prefix}-${randomBytes(4).toString('hex')}`;
const withSource = (item, c) => ({
  ...item,
  sourceContributionIds: [...new Set([...(item.sourceContributionIds || []), c])],
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What a raw proposal must look like before anything is built from it. */
function shapeProblem(p) {
  if (!isObj(p)) return 'record must be an object';
  if (typeof p.text !== 'string') return 'text must be a string';
  if (p.detail !== undefined && typeof p.detail !== 'string') return 'detail must be a string';
  if (p.links !== undefined && !isObj(p.links)) return 'links must be an object';
  if (p.links?.restsOn !== undefined && !(Array.isArray(p.links.restsOn) && p.links.restsOn.every(x => typeof x === 'string'))) return 'links.restsOn must be a list of ids';
  for (const k of ['bends', 'replaces', 'answers']) if (p.links?.[k] != null && typeof p.links[k] !== 'string') return `links.${k} must be an id`;
  if (p.attachedTo !== undefined && !isObj(p.attachedTo)) return 'attachedTo must be an object';
  return null;
}

/**
 * The rules a record must keep with the tree it lives in, for an addition and
 * an edit alike: an exception bends an active rule here, and a record is
 * attached to this tree or to one of its tasks.
 */
function integrityProblem(tree, record, where) {
  if (record.type === 'exception') {
    const rule = tree.records.find(r => r.id === record.links.bends);
    if (!rule) return `links.bends: no record "${record.links.bends}"`;
    if (rule.type !== 'rule') return 'an exception must bend a rule';
    if (rule.status !== 'active') return 'an exception must bend an active rule';
  }
  const a = record.attachedTo;
  if (a.kind === 'task') { if (!tree.tasks.some(t => t.id === a.id)) return `attachedTo: no task "${a.id}" here`; }
  else if (a.kind === 'workstream') { if (!where.id || a.id !== where.id) return 'attachedTo: not this workstream'; }
  else if (a.kind === 'project') { if (where.id) return 'attachedTo: this is a workstream, not the project'; }
  return null;
}

function addRecord(tree, op, c, refs, dropped, onDay, where) {
  const p = op.record;
  const bad = shapeProblem(p);
  if (bad) { dropped.push({ op, reason: bad }); return tree; }
  const links = { restsOn: [], bends: null, replaces: null, answers: null, ...(p.links || {}) };
  // A link may name another record proposed in this same contribution by its `ref`.
  for (const k of ['bends', 'replaces', 'answers']) if (links[k] && refs.has(links[k])) links[k] = refs.get(links[k]);
  links.restsOn = (links.restsOn || []).map(id => refs.get(id) || id);
  const record = {
    id: mint('rec'), type: p.type, text: String(p.text ?? '').trim(), detail: String(p.detail ?? ''),
    status: 'active', owner: p.owner ?? null, attachedTo: p.attachedTo || where.defaultAttach,
    ...(p.reviewBy ? { reviewBy: p.reviewBy } : {}), ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
    links, sourceContributionIds: [c], createdBy: c, approvedBy: null, createdAt: onDay, updatedAt: onDay,
  };
  const v = validateRecord(record);
  if (!v.ok) { dropped.push({ op, reason: v.errors.join('; ') }); return tree; }
  const broken = integrityProblem(tree, record, where);
  if (broken) { dropped.push({ op, reason: broken }); return tree; }
  if (record.links.replaces) {
    const old = tree.records.find(r => r.id === record.links.replaces);
    if (!old || old.status !== 'active' || old.type !== record.type) {
      dropped.push({ op, reason: 'links.replaces must name an active record of the same type' });
      return tree;
    }
  }
  if (op.ref) refs.set(op.ref, record.id);
  let records = [...tree.records, record];
  if (record.links.replaces) {
    records = records.map(r => r.id === record.links.replaces ? { ...withSource(r, c), status: 'replaced', updatedAt: onDay } : r);
  }
  return { ...tree, records };
}

function editRecord(tree, op, c, dropped, onDay, where) {
  const i = tree.records.findIndex(r => r.id === op.id);
  if (i === -1) { dropped.push({ op, reason: `no record "${op.id}"` }); return tree; }
  if (!isObj(op.changes)) { dropped.push({ op, reason: 'changes must be an object' }); return tree; }
  const bad = shapeProblem({ text: tree.records[i].text, ...op.changes, links: op.changes.links });
  if (bad) { dropped.push({ op, reason: bad }); return tree; }
  const changes = Object.fromEntries(Object.entries(op.changes).filter(([k]) => EDITABLE.includes(k)));
  const next = { ...withSource(tree.records[i], c), ...changes, updatedAt: onDay };
  if (changes.links) next.links = { ...tree.records[i].links, ...changes.links };
  const v = validateRecord(next);
  if (!v.ok) { dropped.push({ op, reason: v.errors.join('; ') }); return tree; }
  const broken = integrityProblem(tree, next, where);
  if (broken) { dropped.push({ op, reason: broken }); return tree; }
  return { ...tree, records: tree.records.map((r, j) => j === i ? next : r) };
}

function setStatus(tree, op, c, dropped, onDay) {
  if (!STATUS_TARGETS.includes(op.status)) { dropped.push({ op, reason: `unknown status "${op.status}"` }); return tree; }
  if (!tree.records.some(r => r.id === op.id)) { dropped.push({ op, reason: `no record "${op.id}"` }); return tree; }
  return { ...tree, records: tree.records.map(r => r.id === op.id ? { ...withSource(r, c), status: op.status, updatedAt: onDay } : r) };
}

export function applyOps(tree, ops, contributionId, { onDay = today(), target } = {}) {
  const dropped = [];
  const refs = new Map();
  // Which tree this is decides where its records are attached. A workstream
  // file carries its id; the project's does not.
  const wsId = target !== undefined ? target : (tree?.id || null);
  const where = { id: wsId, defaultAttach: wsId ? { kind: 'workstream', id: wsId } : { kind: 'project' } };
  let next = { ...tree, records: [...(tree.records || [])], tasks: [...(tree.tasks || [])] };
  const list = Array.isArray(ops) ? ops : [];
  const of = (t) => list.filter(o => o?.type === t);
  for (const o of list) if (!OP_TYPES.includes(o?.type)) dropped.push({ op: o, reason: `unknown operation "${o?.type}"` });
  // One malformed proposal is dropped with a reason; it never sinks the rest.
  const each = (items, fn) => { for (const o of items) { try { next = fn(next, o); } catch (e) { dropped.push({ op: o, reason: `could not apply: ${e.message}` }); } } };

  each(of('setGoal'), (t, o) => {
    if (wsId) { dropped.push({ op: o, reason: 'the goal belongs to the project, not to a workstream' }); return t; }
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text) { dropped.push({ op: o, reason: 'goal text is empty' }); return t; }
    return { ...t, goal: withSource({ ...(t.goal || {}), text, updatedAt: onDay }, contributionId) };
  });
  // Tasks before records, so a record can be attached to a task added alongside
  // it; rules before exceptions, so an exception can bend a rule added with it.
  each(of('addTask'), (t, o) => {
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) { dropped.push({ op: o, reason: 'task title is empty' }); return t; }
    const id = mint('task');
    if (o.ref) refs.set(o.ref, id);
    return { ...t, tasks: [...t.tasks, {
      id, title, owner: typeof o.owner === 'string' ? o.owner : null, status: 'open', createdAt: onDay,
      doneAt: null, compiledAt: null, sourceContributionIds: [contributionId], createdBy: contributionId,
    }] };
  });
  const adds = of('addRecord');
  const resolveTaskRef = (o) => (o?.record?.attachedTo?.kind === 'task' && refs.has(o.record.attachedTo.id)
    ? { ...o, record: { ...o.record, attachedTo: { kind: 'task', id: refs.get(o.record.attachedTo.id) } } } : o);
  each(adds.filter(o => o?.record?.type !== 'exception').map(resolveTaskRef), (t, o) => addRecord(t, o, contributionId, refs, dropped, onDay, where));
  each(adds.filter(o => o?.record?.type === 'exception').map(resolveTaskRef), (t, o) => addRecord(t, o, contributionId, refs, dropped, onDay, where));
  each(of('editRecord'), (t, o) => editRecord(t, o, contributionId, dropped, onDay, where));
  each(of('editTask'), (t, o) => {
    if (!t.tasks.some(x => x.id === o.id)) { dropped.push({ op: o, reason: `no task "${o.id}"` }); return t; }
    if (typeof o.title !== 'string' || !o.title.trim()) { dropped.push({ op: o, reason: 'task title is empty' }); return t; }
    return { ...t, tasks: t.tasks.map(x => x.id === o.id ? { ...withSource(x, contributionId), title: o.title.trim() } : x) };
  });
  each(of('setRecordStatus'), (t, o) => setStatus(t, o, contributionId, dropped, onDay));
  each(of('removeTask'), (t, o) => {
    if (!t.tasks.some(x => x.id === o.id)) { dropped.push({ op: o, reason: `no task "${o.id}"` }); return t; }
    return { ...t, tasks: t.tasks.filter(x => x.id !== o.id) };
  });
  return { tree: next, dropped };
}

/**
 * What one contribution left behind, in the order worth pointing somebody at:
 * the goal, then what it created (records, then tasks), then what it only
 * changed. A contribution that adds a decision and retires the old one is about
 * the new decision, not the one it replaced.
 */
export function touchedBy(tree, contributionId) {
  const hit = (x) => (x?.sourceContributionIds || []).includes(contributionId);
  const created = (x) => x?.createdBy === contributionId;
  const records = (tree?.records || []).filter(hit);
  const tasks = (tree?.tasks || []).filter(hit);
  return [
    ...(hit(tree?.goal) ? ['goal'] : []),
    ...records.filter(created).map(r => r.id),
    ...tasks.filter(created).map(t => t.id),
    ...records.filter(r => !created(r)).map(r => r.id),
    ...tasks.filter(t => !created(t)).map(t => t.id),
  ];
}
