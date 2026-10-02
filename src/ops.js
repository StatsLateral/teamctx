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

function addRecord(tree, op, c, refs, dropped, onDay) {
  const p = op.record || {};
  const links = { restsOn: [], bends: null, replaces: null, answers: null, ...(p.links || {}) };
  // A link may name another record proposed in this same contribution by its `ref`.
  for (const k of ['bends', 'replaces', 'answers']) if (links[k] && refs.has(links[k])) links[k] = refs.get(links[k]);
  links.restsOn = (links.restsOn || []).map(id => refs.get(id) || id);
  const record = {
    id: mint('rec'), type: p.type, text: String(p.text ?? '').trim(), detail: String(p.detail ?? ''),
    status: 'active', owner: p.owner ?? null, attachedTo: p.attachedTo || { kind: 'project' },
    ...(p.reviewBy ? { reviewBy: p.reviewBy } : {}), ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
    links, sourceContributionIds: [c], createdBy: c, approvedBy: null, createdAt: onDay, updatedAt: onDay,
  };
  const v = validateRecord(record);
  if (!v.ok) { dropped.push({ op, reason: v.errors.join('; ') }); return tree; }
  if (record.type === 'exception') {
    const target = tree.records.find(r => r.id === record.links.bends);
    if (!target) { dropped.push({ op, reason: `links.bends: no record "${record.links.bends}"` }); return tree; }
    if (target.type !== 'rule') { dropped.push({ op, reason: 'an exception must bend a rule' }); return tree; }
  }
  if (op.ref) refs.set(op.ref, record.id);
  let records = [...tree.records, record];
  if (record.links.replaces) {
    records = records.map(r => r.id === record.links.replaces ? { ...withSource(r, c), status: 'replaced', updatedAt: onDay } : r);
  }
  return { ...tree, records };
}

function editRecord(tree, op, c, dropped, onDay) {
  const i = tree.records.findIndex(r => r.id === op.id);
  if (i === -1) { dropped.push({ op, reason: `no record "${op.id}"` }); return tree; }
  const changes = Object.fromEntries(Object.entries(op.changes || {}).filter(([k]) => EDITABLE.includes(k)));
  const next = { ...withSource(tree.records[i], c), ...changes, updatedAt: onDay };
  if (changes.links) next.links = { ...tree.records[i].links, ...changes.links };
  const v = validateRecord(next);
  if (!v.ok) { dropped.push({ op, reason: v.errors.join('; ') }); return tree; }
  return { ...tree, records: tree.records.map((r, j) => j === i ? next : r) };
}

function setStatus(tree, op, c, dropped, onDay) {
  if (!STATUS_TARGETS.includes(op.status)) { dropped.push({ op, reason: `unknown status "${op.status}"` }); return tree; }
  if (!tree.records.some(r => r.id === op.id)) { dropped.push({ op, reason: `no record "${op.id}"` }); return tree; }
  return { ...tree, records: tree.records.map(r => r.id === op.id ? { ...withSource(r, c), status: op.status, updatedAt: onDay } : r) };
}

export function applyOps(tree, ops, contributionId, { onDay = today() } = {}) {
  const dropped = [];
  const refs = new Map();
  let next = { ...tree, records: [...(tree.records || [])], tasks: [...(tree.tasks || [])] };
  const of = (t) => (ops || []).filter(o => o?.type === t);
  for (const o of (ops || [])) if (!OP_TYPES.includes(o?.type)) dropped.push({ op: o, reason: `unknown operation "${o?.type}"` });

  for (const o of of('setGoal')) {
    const text = String(o.text ?? '').trim();
    if (!text) { dropped.push({ op: o, reason: 'goal text is empty' }); continue; }
    next = { ...next, goal: withSource({ ...(next.goal || {}), text, updatedAt: onDay }, contributionId) };
  }
  for (const o of of('addRecord')) next = addRecord(next, o, contributionId, refs, dropped, onDay);
  for (const o of of('addTask')) {
    const title = String(o.title ?? '').trim();
    if (!title) { dropped.push({ op: o, reason: 'task title is empty' }); continue; }
    next = { ...next, tasks: [...next.tasks, {
      id: mint('task'), title, owner: o.owner ?? null, status: 'open', createdAt: onDay,
      doneAt: null, compiledAt: null, sourceContributionIds: [contributionId], createdBy: contributionId,
    }] };
  }
  for (const o of of('editRecord')) next = editRecord(next, o, contributionId, dropped, onDay);
  for (const o of of('editTask')) {
    if (!next.tasks.some(t => t.id === o.id)) { dropped.push({ op: o, reason: `no task "${o.id}"` }); continue; }
    next = { ...next, tasks: next.tasks.map(t => t.id === o.id ? { ...withSource(t, contributionId), title: String(o.title ?? t.title) } : t) };
  }
  for (const o of of('setRecordStatus')) next = setStatus(next, o, contributionId, dropped, onDay);
  for (const o of of('removeTask')) {
    if (!next.tasks.some(t => t.id === o.id)) { dropped.push({ op: o, reason: `no task "${o.id}"` }); continue; }
    next = { ...next, tasks: next.tasks.filter(t => t.id !== o.id) };
  }
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
