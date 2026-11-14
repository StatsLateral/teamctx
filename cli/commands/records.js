import { getTeamctxDir } from '../../src/storage.js';
import { recordTrailFor } from './records.core.js';

/**
 * `teamctx record history <id>` — print a record's trail (#265): every version
 * it has had, oldest to newest, with who changed it and when, who approved it,
 * and the records it replaced or that replaced it.
 */
export function recordHistoryCommand(id) {
  const trail = recordTrailFor({ teamctxDir: getTeamctxDir(), scope: null, id });
  const when = (v) => (v ? String(v).slice(0, 10) : '—');
  const who = (v) => v || 'someone';

  console.log(`\n${trail.id}  (${trail.type}, ${trail.status})`);
  if (trail.replaces) console.log(`replaces ${trail.replaces.id}${trail.replaces.text ? ` — "${trail.replaces.text}"` : ''}`);
  if (trail.replacedBy) console.log(`replaced by ${trail.replacedBy.id}${trail.replacedBy.text ? ` — "${trail.replacedBy.text}"` : ''}`);

  console.log(`\nVersions (oldest first):`);
  trail.versions.forEach((v, i) => {
    const tag = v.current ? ' (current)' : '';
    console.log(`\n  ${i + 1}. ${when(v.at)} · ${who(v.by)}${tag}`);
    console.log(`     ${v.text}`);
    if (v.detail) console.log(`     ${v.detail}`);
  });

  console.log(`\nCreated ${when(trail.created.at)} by ${who(trail.created.by)}`);
  if (trail.approved) console.log(`Approved ${when(trail.approved.at)} by ${who(trail.approved.by)}`);
  console.log('');
}
