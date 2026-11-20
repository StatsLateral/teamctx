import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { checkGitRepo } from '../../src/git.js';
import { initCommand } from './init.js';

const execFileAsync = promisify(execFile);

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

  // Initialize teamctx if not already done
  if (existsSync('.teamctx')) {
    console.log('✓ teamctx already initialized.\n');
  } else {
    console.log(`When prompted for "GitHub raw base URL", enter:\n  ${rawBase}\n`);
    await initCommand();
  }
}
