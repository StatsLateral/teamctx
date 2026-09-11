import { readConfig, readRoleFile, readTree, readTreeMd, readProject, readContributions, listTasks } from '../../src/storage.js';
import { answerQuestion } from '../../src/context.js';
import { currentIdentity } from '../identity.js';
import { resolveTarget, isProjectLevel } from '../../src/project-level.js';

export async function askCommand(question, opts) {
  const config = readConfig();

  let roleMd = '';
  let roleTarget;
  if (opts.role) {
    const role = config.roles.find(r => r.slug === opts.role);
    if (!role) {
      console.error(`Error: no role "${opts.role}". Run \`teamctx role list\` to see available roles.`);
      process.exit(1);
    }
    roleMd = readRoleFile(opts.role);
    roleTarget = resolveTarget(role.workstream);
  }

  // `roleTarget` stays undefined when no role was named, which is not the same
  // as a role that sits at project level: that one resolves to null, and a
  // falsy test would have sent it to wherever the caller happened to be.
  const chosen = opts.workstream
    ? opts.workstream
    : (roleTarget !== undefined ? roleTarget : (await currentIdentity(config)).activeWorkstream);
  // Project level is where a caller stands unless they chose otherwise, and it
  // has a tree of its own — reading it as a workstream found nothing, and the
  // answer came back as "there is no context yet" on a project full of it.
  const target = resolveTarget(chosen);

  const tree = readTree(target);
  const project = readProject();
  const contributions = readContributions();
  const openTasks = listTasks({ workstream: target }).filter(t => t.status === 'open');

  const answer = await answerQuestion({
    sharedMd: readTreeMd(target), roleMd, question, config, openTasks,
    workstream: tree, contributions, audit: !!opts.audit,
    // A workstream answers with the project above it. The project answers with
    // itself, and passing it twice would put every Why in the prompt twice.
    project: isProjectLevel(target) ? null : project,
  });
  console.log(`\n${answer}\n`);
}
