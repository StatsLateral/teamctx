import { isActive, LABELS } from './model.js';
import { readProject, readTree } from './storage.js';
import { chainFor } from './recompile.js';
import { EDITABLE_RECORD_FIELDS } from './ops.js';

/** The inherited comparison set, never another branch of the project. */
export function comparisonRecords({ config, target, teamctxDir }) {
  const trees = target == null ? [readProject(teamctxDir)]
    : [readProject(teamctxDir), ...chainFor({ config, id: target, teamctxDir })];
  return trees.flatMap(tree => (tree?.records || [])
    .filter(r => isActive(r) && ['decision', 'rule'].includes(r.type))
    .map(r => ({ id: r.id, ...(r.key ? { key: r.key } : {}), type: r.type, text: r.text, workstream: tree.id || null })));
}

export class ContradictionResolutionError extends Error {
  constructor(message) { super(message); this.code = 'CONTRADICTION_RESOLUTION'; }
}

/** Model references are suggestions; identity and both texts come from our data. */
export function normalizeContradictions(raw, operations, records, editableRecords = []) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('Contradiction check returned an invalid list; no changes applied.');
  const result = [];
  for (const hit of raw) {
    const index = hit?.operationIndex;
    const op = Number.isInteger(index) && index >= 0 ? operations[index] : null;
    const matches = records.filter(r => r.id === hit?.recordId
      && (hit.workstream === undefined || r.workstream === hit.workstream));
    if (!op || !['addRecord', 'editRecord'].includes(op.type) || matches.length !== 1) {
      throw new Error('Contradiction check returned an unknown record or operation; no changes applied.');
    }
    const proposedText = op.type === 'addRecord' ? op.record?.text : op.changes?.text;
    if (typeof proposedText !== 'string' || !proposedText.trim()) {
      throw new Error('Contradiction check flagged an operation without proposed text; no changes applied.');
    }
    // A governed exception is explicitly allowed to differ from its rule.
    // This is model semantics, not a judgement to leave to the provider.
    const edited = op.type === 'editRecord' ? editableRecords.find(r => r.id === op.id) : null;
    const proposedRecord = op.type === 'addRecord' ? op.record : edited
      ? { ...edited, links: { ...edited.links, ...op.changes?.links } } : null;
    if (proposedRecord?.type === 'exception' && matches[0].type === 'rule'
      && proposedRecord.links?.bends === matches[0].id) continue;
    if (proposedText.trim() === matches[0].text.trim()) continue;
    if (result.some(r => r.operationIndex === index && r.record.id === matches[0].id && r.record.workstream === matches[0].workstream)) continue;
    result.push({ operationIndex: index, proposedText, record: { ...matches[0] } });
  }
  return result;
}

/**
 * What a queued piece of evidence says, in the words #122 asks for.
 *
 * "(from <source>)" names the person when the contribution had one, because a
 * manager weighing evidence wants to know who saw it as much as where it came
 * in. Both come from the contribution, never from the model.
 */
export function evidenceLabel(op) {
  const against = op?.against?.text ? `'${LABELS.assumption} ${op.against.text}'` : 'an assumption';
  const quote = op?.evidence?.text || '';
  const who = op?.evidence?.by;
  const via = op?.evidence?.source;
  const from = who && via ? ` (from ${who} via ${via})` : who || via ? ` (from ${who || via})` : '';
  return `Evidence against ${against}: "${quote}"${from}`;
}

export const contradictionLabel = conflict => `Contradicts '${LABELS[conflict.record.type]} ${conflict.record.text}' — proposed: '${conflict.proposedText}'`;

export const comparisonFingerprint = records => JSON.stringify(records.map(({ id, type, text, workstream }) => ({ id, type, text, workstream })));

/** Resolve only manager-selected conflicts; never infer permission from a flag. */
export function resolveContradictions(item, { replaces = [], config, teamctxDir }) {
  const target = item.workstream ?? null;
  const conflicts = item.contradictions || [];
  const requested = Array.isArray(replaces) ? replaces : replaces ? [replaces] : [];
  const operations = (item.operations || []).map(op => ({ ...op }));
  const active = comparisonRecords({ config, target, teamctxDir });
  for (const handle of requested) {
    const matching = conflicts.filter(c => c.record.id === handle || c.record.key === handle);
    if (!matching.length) throw new ContradictionResolutionError(`"${handle}" is not a flagged record on this contribution.`);
    for (const conflict of matching) {
      if (conflict.record.workstream !== target) throw new ContradictionResolutionError('This conflict is inherited. Replace or retire the record in its own part of the work, then review this contribution again.');
      const old = active.find(r => r.id === conflict.record.id && r.workstream === target);
      if (!old) continue;
      const op = operations[conflict.operationIndex];
      if (op?.type === 'addRecord') {
        if (op.record?.type !== old.type) throw new ContradictionResolutionError('A replacement must have the same record type as the decision or rule it replaces.');
        if (op.record.links?.replaces && op.record.links.replaces !== old.id) throw new ContradictionResolutionError('This proposed record already replaces another record. Resolve the additional conflict separately.');
        operations[conflict.operationIndex] = { ...op, record: { ...op.record, links: { ...op.record.links, replaces: old.id } } };
      } else if (op?.type === 'editRecord') {
        const tree = readTree(target, teamctxDir);
        const existing = tree.records.find(r => r.id === op.id);
        if (!existing || existing.type !== old.type || existing.id !== old.id) throw new ContradictionResolutionError('To replace a different record, submit an explicit replacement contribution. This edit cannot retire another decision or rule.');
        const changes = Object.fromEntries(Object.entries(op.changes || {}).filter(([key]) => EDITABLE_RECORD_FIELDS.includes(key)));
        // The new record's own fields only. Spreading the old record carried its
        // id, key, status and history into the proposal, so the approval result
        // named the new record as the one it replaced (D-12) while the stored
        // record was D-16. `applyOps` mints the identity; nothing here should
        // look like it has one already.
        const { id: _id, key: _key, status: _status, sourceContributionIds: _src, createdBy: _by,
          approvedBy: _ok, createdAt: _at, updatedAt: _up, reviewedAt: _rv, brokenAt: _br, ...fields } = existing;
        const record = { ...fields, ...changes, links: { ...existing.links, ...changes.links, replaces: old.id } };
        operations[conflict.operationIndex] = { type: 'addRecord', record };
      } else throw new ContradictionResolutionError('The flagged operation has changed; resubmit this contribution for review.');
    }
  }
  for (const conflict of conflicts) {
    const old = active.find(r => r.id === conflict.record.id && r.workstream === conflict.record.workstream);
    if (!old) continue; // A manager has already retired the inherited/local choice.
    if (old.text !== conflict.record.text) throw new ContradictionResolutionError('A compared decision or rule has changed since this check. Resubmit the contribution against the current context before approval.');
    const op = operations[conflict.operationIndex];
    const resolves = old.workstream === target && op?.type === 'addRecord'
      && op.record?.type === old.type && op.record?.links?.replaces === old.id;
    if (!resolves) throw new ContradictionResolutionError(`${contradictionLabel(conflict)}. Specify --replaces ${old.key || old.id}, resolve an inherited record in its own part of the work, or reject this contribution.`);
  }
  return { ...item, operations };
}
