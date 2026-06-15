import { existsSync } from 'fs';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { ask } from '../prompt.js';
import { checkGitRepo } from '../../src/git.js';
import { initCommand } from './init.js';

const execFileAsync = promisify(execFile);

// MVP: hardcoded to the single hosted Vercel project.
// Post-MVP: make this configurable (ask user or read from config).
const VERCEL_PROJECT = 'git-for-non-tech-teams';

function setVercelEnv(key, value) {
  const r = spawnSync('vercel', ['env', 'add', key, 'production', '--project', VERCEL_PROJECT], {
    input: value + '\n',
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`vercel env add ${key} failed`);
}

async function getGitRemoteUrl() {
  const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin']);
  return stdout.trim();
}

function parseGitHubUrl(url) {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`Cannot parse GitHub URL: ${url}`);
  return { owner: m[1], repo: m[2] };
}

async function getCurrentBranch() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim() || 'main';
  } catch {
    return 'main';
  }
}

export async function setupCommand() {
  await checkGitRepo();

  // Detect repo from git remote
  const remoteUrl = await getGitRemoteUrl().catch(() => null);
  if (!remoteUrl) {
    console.error('No git remote found. Add a remote (git remote add origin <url>) first.');
    process.exit(1);
  }

  let owner, repoName;
  try {
    ({ owner, repo: repoName } = parseGitHubUrl(remoteUrl));
  } catch {
    console.error('Remote does not look like a GitHub repo. Expected: github.com/owner/repo');
    process.exit(1);
  }

  const branch = await getCurrentBranch();
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}`;

  console.log(`\nSetting up teamctx for ${owner}/${repoName}\n`);

  // GitHub token — fine-grained PAT scoped to this repo, Contents: read+write
  const token = await ask('GitHub token (fine-grained PAT, Contents: read+write on this repo)');
  if (!token) { console.error('Token is required.'); process.exit(1); }

  // Verify token has access
  process.stdout.write('→ Verifying access...');
  const verifyRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!verifyRes.ok) {
    console.error(`\nCannot access ${owner}/${repoName} (HTTP ${verifyRes.status}).`);
    console.error('Check that the token has Contents: read+write on this repo.');
    process.exit(1);
  }
  console.log(' ok.\n');

  // Initialize teamctx if not already done
  if (existsSync('.teamctx')) {
    console.log('✓ teamctx already initialized.\n');
  } else {
    console.log(`When prompted for "GitHub raw base URL", enter:\n  ${rawBase}\n`);
    await initCommand();
  }

  // Set Vercel env vars
  const envVars = {
    GITHUB_REPO: `${owner}/${repoName}`,
    GITHUB_RAW_BASE: rawBase,
    GITHUB_TOKEN: token,
  };

  console.log(`\n→ Setting env vars on Vercel project "${VERCEL_PROJECT}"...`);
  for (const [key, value] of Object.entries(envVars)) {
    process.stdout.write(`  ${key}... `);
    try {
      setVercelEnv(key, value);
      console.log('✓');
    } catch (err) {
      console.log(`failed — ${err.message}`);
    }
  }

  console.log('\n✓ Done. Deploy to pick up the new env vars:');
  console.log(`  vercel --prod --cwd path/to/git-for-non-tech-teams\n`);

  // Post-MVP: prompt for Vercel project name, support multiple deployments.
  // Post-MVP: offer to trigger the deploy automatically.
}
