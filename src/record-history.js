/**
 * A record's trail: what it said over time, who changed it, who approved it, and
 * how it connects to the record it replaced or that replaced it (#265).
 *
 * Pure, like task-history.js: every version already lives on the record
 * (`history` + the current values) and the chain is two pointers
 * (`links.replaces` new → old, `replacedBy` old → new). The caller resolves who
 * a contribution was, and decides who this reader may name — a contribution it
 * cannot resolve, or a name the caller may not show, comes back as `by: null`
 * ("someone"), never guessed.
 *
 * A record written before history was kept has no `history`; it reads as a
 * single current version, not an error.
 */

/**
 * `{ id, type, status, versions, replaces, replacedBy, created, approved }`.
 *
 * - `versions`   oldest → newest, each `{ text, detail, at, by, contribution, current? }`
 * - `replaces`   the record this one replaced, `{ id, text, status }` or null
 * - `replacedBy` the record that replaced this one, `{ id, text, status }` or null
 * - `created`    `{ by, at }` — who first wrote it
 * - `approved`   `{ by, at }` or null
 *
 * @param {object}   input
 * @param {object}   input.record         the record to trace
 * @param {object[]} [input.records]       sibling records, to resolve the chain
 * @param {object}   [input.contributions] id → `{ author, ts }`
 * @param {object}   [input.approvals]     id → `{ approvedBy: { name }|null, approvedAt }`
 * @param {function} [input.canSee]        name → may this reader see it
 */
export function recordTrail({ record, records = [], contributions = {}, approvals = {}, canSee = () => true } = {}) {
  if (!record) return null;

  const name = (n) => (n && canSee(n) ? n : null);
  const whoOf = (cid) => name(contributions[cid]?.author || null);
  const hist = Array.isArray(record.history) ? record.history : [];

  // Each history entry is a past version's values, with the contribution that
  // superseded it. So a version's own author is whoever's change produced it:
  // the first by `createdBy`, each later one by the edit before it in the list.
  const versions = hist.map((h, k) => ({
    text: h.text ?? '',
    detail: h.detail ?? '',
    at: h.at || null,
    by: whoOf(k === 0 ? record.createdBy : hist[k - 1].byContribution),
    contribution: (k === 0 ? record.createdBy : hist[k - 1].byContribution) || null,
  }));
  versions.push({
    text: record.text ?? '',
    detail: record.detail ?? '',
    at: record.updatedAt || record.createdAt || null,
    by: whoOf(hist.length ? hist[hist.length - 1].byContribution : record.createdBy),
    contribution: (hist.length ? hist[hist.length - 1].byContribution : record.createdBy) || null,
    current: true,
  });

  const brief = (id) => {
    if (!id) return null;
    const r = records.find((x) => x.id === id);
    return r ? { id: r.id, text: r.text ?? '', status: r.status } : { id, text: null, status: null };
  };

  const approval = approvals[record.createdBy]
    || Object.values(approvals).find((a) => a && a.approvedBy && record.approvedBy) || null;
  const approved = record.approvedBy
    ? { by: name(record.approvedBy.name || null), at: approval?.approvedAt || null }
    : null;

  return {
    id: record.id,
    type: record.type,
    status: record.status,
    versions,
    replaces: brief(record.links?.replaces),
    replacedBy: brief(record.replacedBy),
    created: { by: whoOf(record.createdBy), at: record.createdAt || null },
    approved,
  };
}
