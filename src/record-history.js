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

  // Each history entry is a past version's values plus the transition that
  // ended it (`at` = when it was superseded, `byContribution` = the edit that
  // did so). So a version is dated and attributed by the transition INTO it:
  // the first by the record's own creation, each later one by the entry before
  // it. Dating from the transition — not the record's `updatedAt` — keeps an
  // unrelated metadata edit from mis-dating a version.
  const intoVersion = (k) => (k === 0
    ? { by: record.createdBy, at: record.createdAt || null }
    : { by: hist[k - 1].byContribution, at: hist[k - 1].at || null });
  const versions = hist.map((h, k) => ({
    text: h.text ?? '',
    detail: h.detail ?? '',
    at: intoVersion(k).at,
    by: whoOf(intoVersion(k).by),
    contribution: intoVersion(k).by || null,
  }));
  versions.push({
    text: record.text ?? '',
    detail: record.detail ?? '',
    at: intoVersion(hist.length).at || record.updatedAt || null,
    by: whoOf(intoVersion(hist.length).by),
    contribution: intoVersion(hist.length).by || null,
    current: true,
  });

  const brief = (id) => {
    if (!id) return null;
    const r = records.find((x) => x.id === id);
    return r ? { id: r.id, text: r.text ?? '', status: r.status } : { id, text: null, status: null };
  };

  // The approver is the one recorded on the record; the date, when there is one,
  // comes from the approval of the contribution that created it — not an
  // arbitrary approval elsewhere in the directory. Absent when none is on record.
  const approved = record.approvedBy
    ? { by: name(record.approvedBy.name || null), at: approvals[record.createdBy]?.approvedAt || null }
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
