import { renderBrief } from './brief.js';
import { isActive, today } from './model.js';

/**
 * The prompts behind the page's assistant actions, built from what the reader
 * was sent and nothing else.
 *
 * `view` is the project view the page already holds. It was scoped for this
 * reader before it got here, so a prompt built from it can only ever carry what
 * they may see: a workstream they cannot read is not in `view.trees`, and shows
 * up in the index only as a count of parts they cannot see, never by name.
 *
 * Two prompts per place (the project, or one workstream):
 *   short  asks an assistant that is connected to teamctx to fetch the approved
 *          context itself. Nothing travels in a link, so it is never truncated
 *          and is always the latest the person may see.
 *   full   carries the context inline, for an assistant that is not connected:
 *          the goal, the records of every level on the path down to this one
 *          (outermost first, an exception under the rule it bends, in words), and
 *          an index of everything else so "I was not shown it" is never mistaken
 *          for "there is none".
 */

export function connectedPrompt({ owner, repo, subject, scope }) {
  return [
    `Tell me about ${subject}.`,
    '',
    'Instructions for the AI agent:',
    `- Confirm you are connected to the repository ${owner}/${repo}. get_connect_url returns a URL containing the owner and repo. If it is a different one, stop and tell me, rather than answering from the project you are connected to.`,
    `- Use the teamctx connector to fetch the current approved context for ${scope} and answer from it.`,
    `- Keep to ${scope}. Do not summarise other parts of the project unless I ask.`,
    '- Answer in plain language, the way a colleague would. Where something has not been decided yet, say so and move on.',
  ].join('\n');
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line per workstream outside the path, and a count of what cannot be seen. */
function indexOf({ workstreams, trees, openTasks, exclude, hidden, onDay }) {
  const lines = workstreams.filter(w => !exclude.has(w.id)).map(w => {
    const records = (trees[w.id]?.records || []).filter(r => isActive(r, onDay)).length;
    const open = openTasks.filter(t => t.workstream === w.id).length;
    return `- ${w.number ? `${w.number} ` : ''}${w.name || 'Unnamed part'} — ${plural(records, 'active record')}, ${plural(open, 'open task')}`;
  });
  if (hidden > 0) lines.push(`- ${plural(hidden, 'part')} you cannot see`);
  if (!lines.length) return '';
  return ['', '## Not loaded here', ...lines, 'Ask for more through the connector if you need them.', ''].join('\n');
}

/**
 * `{ project: { short, full }, ws: { [id]: { short, full } } }` for everything a
 * reader can open a drawer on.
 */
export function drawerPrompts({ view, onDay = today() }) {
  const name = view.project || `${view.owner}/${view.repo}`;
  const trees = view.trees || {};
  const visible = view.workstreams || [];
  const byId = new Map(visible.map(w => [w.id, w]));
  const openTasks = view.tasks?.open || [];
  const hidden = Number(view.hiddenParts) || 0;
  const flagged = new Set([view.projectTree, ...Object.values(trees)]
    .flatMap(t => (t?.records || []).filter(r => r.needsReview).map(r => r.id)));

  const full = ({ chain, exclude, scope }) => [
    `This is the approved context for ${scope}, from the project "${name}".`,
    'Answer only from it. If something is not here, say so rather than guessing.',
    '',
    renderBrief({ projectName: name, project: view.projectTree, chain, onDay, flagged }).trimEnd(),
    indexOf({ workstreams: visible, trees, openTasks, exclude, hidden, onDay }),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  const out = {
    project: {
      short: connectedPrompt({ owner: view.owner, repo: view.repo, subject: 'this project', scope: 'the project as a whole (its goal and the project-level context)' }),
      full: full({ chain: [], exclude: new Set(), scope: 'the project as a whole' }),
    },
    ws: {},
  };

  for (const w of visible) {
    // Every part above this one that the reader may see, outermost first. A part
    // they cannot see is left out of the path rather than named.
    const path = [];
    for (let cur = w.parent; cur && byId.has(cur) && !path.some(p => p.id === cur); cur = byId.get(cur).parent) {
      path.unshift(byId.get(cur));
    }
    const chain = [...path, w].map(p => ({ ...(trees[p.id] || { id: p.id, records: [], tasks: [] }), id: p.id, name: p.name, number: p.number ? String(p.number) : '' }));
    const label = `workstream ${w.number ? `${w.number} ` : ''}(${w.name})`.replace('  ', ' ');
    out.ws[w.id] = {
      short: connectedPrompt({ owner: view.owner, repo: view.repo, subject: label, scope: `${label} and the project context it inherits` }),
      full: full({ chain, exclude: new Set(chain.map(c => c.id)), scope: label }),
    };
  }
  return out;
}

/**
 * A level's records as plain-English groups: what was decided, the rules (each
 * with the exceptions that bend it), what is being assumed. Wording only, no
 * numbers or ids. An exception is only ever shown under the rule it bends, since
 * read without its rule it is a contradiction, not context.
 */
export function contextGroups(records, onDay = today()) {
  const active = (records || []).filter(r => isActive(r, onDay));
  const flag = (r) => (r.needsReview ? String(r.needsReview) : '');
  const entry = (r, extra = {}) => ({ text: r.text, detail: r.detail || '', flag: flag(r), ...extra });
  return {
    decided: active.filter(r => r.type === 'decision').map(r => entry(r)),
    rules: active.filter(r => r.type === 'rule').map(rule => entry(rule, {
      exceptions: active.filter(e => e.type === 'exception' && e.links?.bends === rule.id)
        .map(e => entry(e, { until: e.expiresAt || '' })),
    })),
    assuming: active.filter(r => r.type === 'assumption').map(r => entry(r, { checkBy: r.reviewBy || '' })),
  };
}
