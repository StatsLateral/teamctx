import { buildBrief } from './brief.core.js';
import { currentIdentity } from '../identity.js';
import { readConfig } from '../../src/storage.js';

/** Presentation only — the brief itself is built in brief.core.js. */
export async function briefCommand() {
  const config = readConfig();
  const { activeWorkstream } = await currentIdentity(config);
  const brief = await buildBrief({ activeWorkstream });

  console.log(`\n${brief.frame}\n`);

  if (brief.role) {
    console.log(`Your role: ${brief.role.name}\n`);
  }

  brief.tasks.open.forEach(group => {
    console.log(`Your open tasks — ${group.name}:`);
    group.tasks.forEach(t => console.log(`  ${t.id}  ${t.title}`));
    console.log('');
  });

  brief.context.forEach(part => {
    if (!part.markdown) {
      console.log(`Nothing has been written about ${part.name} yet.\n`);
      return;
    }
    console.log(part.markdown.trimEnd());
    console.log('');
  });

  if (brief.tasks.done.length) {
    const finished = brief.tasks.done.reduce((n, g) => n + g.tasks.length, 0);
    console.log(`(${finished} of your task${finished === 1 ? '' : 's'} already finished — \`teamctx task list --mine --all\` to see them.)\n`);
  }
}
