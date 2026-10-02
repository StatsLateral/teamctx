let n = 0;
const next = (p) => `${p}-${++n}`;

export function makeRecord(over = {}) {
  const type = over.type || 'decision';
  const base = {
    id: next('rec'), type, text: `${type} text`, detail: '', status: 'active',
    owner: ['assumption', 'question', 'risk'].includes(type) ? { key: 'git:owner@x', name: 'Owner' } : null,
    attachedTo: { kind: 'project' },
    links: { restsOn: [], bends: null, replaces: null, answers: null },
    sourceContributionIds: [], approvedBy: null,
    createdAt: '2026-10-01', updatedAt: '2026-10-01',
  };
  if (type === 'assumption') base.reviewBy = '2026-12-01';
  if (type === 'exception') { base.expiresAt = '2026-12-31'; base.links.bends = 'rec-rule'; }
  return { ...base, ...over, links: { ...base.links, ...(over.links || {}) } };
}

export function makeTask(over = {}) {
  return {
    id: next('task'), title: 'A task', owner: null, status: 'open',
    createdAt: '2026-10-01', doneAt: null, compiledAt: null, sourceContributionIds: [], ...over,
  };
}

export function makeProject(over = {}) {
  return { name: 'Project', goal: null, records: [], tasks: [], ...over };
}

export function makeWorkstream(id, over = {}) {
  return { id, name: id, records: [], tasks: [], ...over };
}

export function makeConfig(over = {}) {
  return {
    project: 'Project', me: 'Manager', managerKey: 'git:manager@x', reviewPolicy: 'all',
    members: [], roles: [], workstreams: [], ...over,
  };
}
