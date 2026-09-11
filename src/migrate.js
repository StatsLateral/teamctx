import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { readConfig, writeConfig, writeWorkstream, writeWorkstreamMd } from './storage.js';
import { getCurrentSession } from './session-context.js';
import { migrateProjectLayer } from './migrate-project-layer.js';

export function migrateIfNeeded(teamctxDir) {
  // Hosted has no filesystem, and `teamctxDir` is not even a path there — it is
  // the repo the session is scoped to. This function used to open with
  // `join(teamctxDir, ...)`, which threw on the first line of every hosted
  // call, and the caller's best-effort catch made it look like a project that
  // needed nothing. So hosted projects went unmigrated while the code read as
  // though they did not.
  if (getCurrentSession()) {
    let hostedConfig;
    try { hostedConfig = readConfig(teamctxDir); } catch { return false; }
    // The half below this reads `shared.json` off disk, from before workstreams
    // existed. Nothing hosted is that old — `init` has written both migration
    // flags since hosted projects were first creatable — so the project layer
    // is the only migration a hosted project can need.
    return hostedConfig.workstreamsMigrated ? migrateProjectLayer(teamctxDir) : false;
  }

  const configPath = join(teamctxDir, 'config.json');
  if (!existsSync(configPath)) return false;

  const config = readConfig(teamctxDir);
  // Runs after the workstreams migration on a project that needs both, because
  // it folds `main` away and the older one is what creates `main`.
  if (config.workstreamsMigrated) return migrateProjectLayer(teamctxDir);

  const sharedPath = join(teamctxDir, 'shared.json');
  let workstream;
  if (existsSync(sharedPath)) {
    workstream = JSON.parse(readFileSync(sharedPath, 'utf-8'));
  } else {
    workstream = { id: 'main', name: config.project || '', whys: [] };
  }
  workstream.id = 'main';
  writeWorkstream('main', workstream, teamctxDir);

  const sharedMdPath = join(teamctxDir, 'context', 'shared.md');
  if (existsSync(sharedMdPath)) {
    writeWorkstreamMd('main', readFileSync(sharedMdPath, 'utf-8'), teamctxDir);
    unlinkSync(sharedMdPath);
  }

  const updated = {
    ...config,
    workstreams: [{ id: 'main', name: config.project || 'main', createdAt: new Date().toISOString() }],
    activeWorkstream: 'main',
    roles: (config.roles || []).map(r => ({ ...r, workstream: r.workstream || 'main' })),
    workstreamsMigrated: true,
  };
  writeConfig(updated, teamctxDir);

  if (existsSync(sharedPath)) unlinkSync(sharedPath);
  migrateProjectLayer(teamctxDir);
  return true;
}
