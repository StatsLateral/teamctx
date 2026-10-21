/**
 * `teamctx doctor`: check the setup up front, and say how to fix each problem
 * (#180). Without it a missing key fails at the first AI call and a broken gate
 * at the first approval, each in the middle of something else.
 *
 * Every check is one line: ok, a failure with one action to fix it, or skipped.
 * A check that needs an earlier one is skipped when that one failed, so the
 * first failure is the one to fix first.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getTeamctxDir, readConfig } from '../../src/storage.js';
import { missingKeyMessage } from '../../src/providers/missing-key.js';
import { verifyProviderKey } from '../../src/providers/verify-key.js';
import { isBrokenGate } from '../../src/manager-repair.js';

const execFileAsync = promisify(execFile);
const realGit = async (args, { cwd }) => (await execFileAsync('git', args, { cwd })).stdout;

/** Where each provider's key is read from, and what to call it. */
const KEYS = {
  anthropic: { env: 'ANTHROPIC_API_KEY', name: 'Anthropic' },
  openai: { env: 'OPENAI_API_KEY', name: 'OpenAI' },
  gemini: { env: 'GEMINI_API_KEY', name: 'Gemini' },
};

const ENGINES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf-8')).engines?.node || '>=18';

const parts = v => String(v).replace(/^v/, '').split('.').map(n => Number.parseInt(n, 10) || 0);

/** Whether `version` meets a `>=x[.y[.z]]` range, the only form `engines` uses here. */
export function meetsEngines(version, range = ENGINES) {
  const min = /^\s*>=\s*v?([\d.]+)\s*$/.exec(range)?.[1];
  if (!min) return true;
  const have = parts(version);
  const need = parts(min);
  for (let i = 0; i < 3; i++) {
    if ((have[i] || 0) !== (need[i] || 0)) return (have[i] || 0) > (need[i] || 0);
  }
  return true;
}

const ok = name => ({ name, status: 'ok' });
const fail = (name, fix) => ({ name, status: 'fail', fix });
const skip = (name, why) => ({ name, status: 'skip', fix: why });

export async function runDoctor({
  cwd = process.cwd(), env = process.env, offline = false, fetchImpl = globalThis.fetch,
  git = realGit, nodeVersion = process.version,
} = {}) {
  const checks = [];

  let inRepo = true;
  try { await git(['rev-parse', '--git-dir'], { cwd }); } catch { inRepo = false; }
  checks.push(inRepo ? ok('Git repository') : fail('Git repository', 'Not inside a git repository. Run `git init`, then `teamctx init`.'));

  let config = null;
  try { config = readConfig(getTeamctxDir(cwd)); } catch { config = null; }
  checks.push(config ? ok('teamctx project') : fail('teamctx project', 'No teamctx project here. Run `teamctx init`.'));

  checks.push(meetsEngines(nodeVersion)
    ? ok('Node version')
    : fail('Node version', `Node ${nodeVersion} is older than teamctx needs (${ENGINES}). Install Node 18 or later.`));

  const noProject = 'needs a teamctx project';
  if (!config) {
    for (const name of ['AI key present', 'AI key accepted', 'Manager gate', 'Remote for auto-push']) checks.push(skip(name, noProject));
    return checks;
  }

  const provider = config.provider || 'anthropic';
  const key = KEYS[provider];
  const apiKey = key && String(env[key.env] || '').trim();
  if (!key) checks.push(fail('AI key present', `Unknown provider "${provider}". Run \`teamctx config provider anthropic\` (or openai, gemini).`));
  else checks.push(apiKey ? ok('AI key present') : fail('AI key present', missingKeyMessage(key.env, key.name)));

  if (!apiKey) checks.push(skip('AI key accepted', 'needs a key'));
  else if (offline) checks.push(skip('AI key accepted', 'skipped with --offline'));
  else {
    const checked = await verifyProviderKey({ provider, apiKey }, fetchImpl);
    checks.push(checked.ok
      ? ok('AI key accepted')
      : fail('AI key accepted', checked.transient
        ? `${checked.why.replace(/ Try again in a minute\.$/, '')} Check the network, then run \`teamctx doctor\` again.`
        : `${checked.why} Replace ${key.env} in .env.local with a working key.`));
  }

  checks.push(isBrokenGate(config)
    ? fail('Manager gate', 'Nobody can approve: the manager gate names someone no identity matches. Run `teamctx config manager --repair`.')
    : ok('Manager gate'));

  if (!config.autoPush) checks.push(skip('Remote for auto-push', 'auto-push is off'));
  else if (!inRepo) checks.push(skip('Remote for auto-push', 'needs a git repository'));
  else {
    let remotes = '';
    try { remotes = String(await git(['remote'], { cwd })).trim(); } catch { remotes = ''; }
    checks.push(remotes
      ? ok('Remote for auto-push')
      : fail('Remote for auto-push', 'Auto-push is on but this repository has no remote. Add one with `git remote add origin <url>`.'));
  }
  return checks;
}
