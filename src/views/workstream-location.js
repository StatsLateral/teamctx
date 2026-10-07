/** Names only, from the workstreams this reader is allowed to see. */
export function workstreamLocation(workstreams, id, project = 'Overall project') {
  if (!id) return project || 'Overall project';
  const byId = new Map(workstreams.map(w => [w.id, w]));
  const names = [];
  const seen = new Set();
  for (let current = id; current && !seen.has(current);) {
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) break;
    names.unshift(entry.name || 'Unnamed part of work');
    current = entry.parent;
  }
  return names.join(' › ') || 'Unavailable part of work';
}
