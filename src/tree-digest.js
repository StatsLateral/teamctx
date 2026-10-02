/**
 * What just went into a project's context, in a form a person can hear back.
 *
 * The founding contribution is usually a long conversation the manager pasted
 * in, and what comes back is a summary line and a list of typed operations —
 * neither of which says what the project's context now *is*. So the one person
 * who could correct it has no way to check it, at the one moment when checking
 * is cheap.
 *
 * This is the whole tree, trimmed: enough for an assistant to read back in a few
 * sentences, not so much that it repeats the conversation the manager just had.
 */

const LIMITS = { settled: 8, workstreams: 12, chars: 160 };

function trim(text, chars) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > chars ? `${s.slice(0, chars - 1).trimEnd()}…` : s;
}

/**
 * `{ goal, why, settled, workstreams, counts, more }` — `settled` is the
 * project's active decisions and rules.
 *
 * `counts` covers everything, including what was left out, so the assistant can
 * say "and four more" rather than implying the list is the whole of it.
 */
export function digestProject({ project, workstreams = [] } = {}, limits = {}) {
  const { settled: maxSettled, workstreams: maxWs, chars } = { ...LIMITS, ...limits };
  const trees = [project, ...workstreams].filter(Boolean);
  const counts = { tasks: 0 };
  for (const t of trees) {
    for (const r of t.records || []) if (r.status === 'active') counts[r.type] = (counts[r.type] || 0) + 1;
    counts.tasks += (t.tasks || []).length;
  }
  const allSettled = (project?.records || []).filter(r => ['decision', 'rule'].includes(r.type) && r.status === 'active');
  return {
    goal: project?.goal?.text ? trim(project.goal.text, chars) : null,
    why: project?.goal?.why ? trim(project.goal.why, chars) : null,
    settled: allSettled.slice(0, maxSettled).map(r => trim(r.text, chars)),
    workstreams: workstreams.slice(0, maxWs).map(w => ({
      number: w.number || null,
      name: trim(w.name || w.id, chars),
      tasks: (w.tasks || []).length,
      records: (w.records || []).filter(r => r.status === 'active').length,
    })),
    counts,
    more: allSettled.length > maxSettled || workstreams.length > maxWs,
  };
}
