function walkNodes(tree, fn) {
  if (tree?.goal) fn(tree.goal, 'goal', null);
  for (const r of tree?.records || []) fn(r, 'record', null);
  for (const t of tree?.tasks || []) fn(t, 'task', null);
}

function contributionIndex(contributions) {
  const map = new Map();
  for (const c of contributions || []) {
    if (c && c.id) map.set(c.id, c);
  }
  return map;
}

export function collectContributorCounts(workstream, contributions, { citedIds } = {}) {
  const byId = contributionIndex(contributions);
  const cited = citedIds instanceof Set ? citedIds : (Array.isArray(citedIds) ? new Set(citedIds) : null);
  // Group by `authorKey` where it exists, so one person is one contributor even
  // when their display name differs between surfaces (git name on the CLI,
  // GitHub name on the hosted server). Contributions written before authorKey
  // existed have only `author`, and group by that exactly as before.
  const seenPerAuthor = new Map();
  walkNodes(workstream, node => {
    for (const id of node.sourceContributionIds || []) {
      if (cited && !cited.has(id)) continue;
      const c = byId.get(id);
      if (!c || !c.author) continue;
      const key = c.authorKey || `name:${c.author}`;
      let entry = seenPerAuthor.get(key);
      if (!entry) { entry = { author: c.author, ts: c.ts || '', ids: new Set() }; seenPerAuthor.set(key, entry); }
      // Most recent contribution wins the display name.
      if ((c.ts || '') >= entry.ts) { entry.author = c.author; entry.ts = c.ts || ''; }
      entry.ids.add(id);
    }
  });
  const counts = [];
  for (const { author, ids } of seenPerAuthor.values()) {
    let decisions = 0;
    for (const id of ids) if (byId.get(id)?.tagged === 'decision') decisions += 1;
    counts.push({ author, total: ids.size, decisions });
  }
  return counts.sort((a, b) => b.total - a.total || a.author.localeCompare(b.author));
}

export function collectSourceRefs(workstream, contributions) {
  const byId = contributionIndex(contributions);
  const seenContribs = new Map();
  const unknown = new Set();
  walkNodes(workstream, (node, tier) => {
    const ids = node.sourceContributionIds || [];
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) {
        unknown.add(id);
        continue;
      }
      if (seenContribs.has(id)) {
        seenContribs.get(id).nodes.push({ id: node.id, tier, text: node.text ?? node.title });
        continue;
      }
      seenContribs.set(id, {
        contributionId: id,
        author: c.author || 'unknown',
        ts: c.ts || '',
        source: c.source || 'cli',
        tagged: c.tagged || null,
        text: c.text || '',
        nodes: [{ id: node.id, tier, text: node.text ?? node.title }],
      });
    }
  });
  const out = [...seenContribs.values()].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  return { sources: out, unknown: [...unknown] };
}

export function formatContributorLine(counts) {
  if (!counts || counts.length === 0) return '';
  const parts = counts.map(c => {
    const decisionTag = c.decisions > 0 ? `, ${c.decisions} decision${c.decisions !== 1 ? 's' : ''}` : '';
    return `${c.author} (${c.total}${decisionTag})`;
  });
  return `**Contributions from:** ${parts.join(', ')}`;
}

export function formatContributorsSection(counts) {
  if (!counts || counts.length === 0) return '';
  const lines = counts.map(c => {
    const decisionTag = c.decisions > 0 ? ` (${c.decisions} decision${c.decisions !== 1 ? 's' : ''})` : '';
    return `- **${c.author}** — ${c.total} contribution${c.total !== 1 ? 's' : ''}${decisionTag}`;
  });
  return `## Contributors\n\n${lines.join('\n')}\n`;
}

export function formatAuditBlock({ sources, unknown }) {
  if ((!sources || sources.length === 0) && (!unknown || unknown.length === 0)) return '';
  const lines = ['**Sources**', ''];
  for (const s of sources) {
    const date = (s.ts || '').split('T')[0] || 'unknown date';
    const decisionTag = s.tagged === 'decision' ? '**decision** — ' : '';
    const snippet = (s.text || '').split('\n')[0].slice(0, 120);
    lines.push(`- ${decisionTag}${s.author}, ${date} (${s.source}) — ${snippet}`);
  }
  if (unknown && unknown.length > 0) {
    lines.push('');
    lines.push(`_${unknown.length} source${unknown.length !== 1 ? 's' : ''} unknown — likely predate the audit feature or were removed._`);
  }
  return lines.join('\n');
}
