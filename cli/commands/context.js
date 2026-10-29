import { readRoleFile, readConfig } from '../../src/storage.js';
import { contextFreshness, freshnessLine, withFreshness } from '../../src/freshness.js';

export async function contextCommand(role) {
  const config = readConfig();
  if (!config.roles.find(r => r.slug === role)) {
    console.error(`Error: role "${role}" not found. Run \`teamctx role list\` to see available roles.`);
    process.exit(1);
  }
  try {
    const found = config.roles.find(r => r.slug === role);
    process.stdout.write(withFreshness(readRoleFile(role), freshnessLine(contextFreshness(undefined, { role: found }))));
  } catch {
    console.error(`Error: context file for "${role}" not found. It may not have been generated yet.`);
    process.exit(1);
  }
}
