import { existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ask } from '../prompt.js';
import { initCommand } from './init.js';

const execFileAsync = promisify(execFile);

async function ghFetch(url, token, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `GitHub API error ${res.status}`);
  return data;
}

export async function setupCommand() {
  console.log('\nSetting up teamctx with a new private GitHub repo.');
  console.log('You need a GitHub classic PAT with "repo" scope.');
  console.log('Create one at: https://github.com/settings/tokens/new\n');

  // 1. GitHub token
  const token = await ask('GitHub personal access token');
  if (!token) { console.error('Token is required.'); process.exit(1); }

  // 2. Verify token + get user info
  process.stdout.write('→ Verifying token...');
  let user;
  try {
    user = await ghFetch('https://api.github.com/user', token);
    process.stdout.write(` authenticated as ${user.login}.\n\n`);
  } catch (err) {
    console.error(`\nInvalid token: ${err.message}`);
    process.exit(1);
  }

  // 3. Personal account or org?
  const ownerAnswer = await ask(`Create repo under your account (${user.login}) or an org? Enter org name, or press Enter for personal account`, '');
  const owner = ownerAnswer.trim() || user.login;

  // 4. Repo name
  const repoName = await ask('Private repo name for team context data', 'team-context');
  if (!repoName) { console.error('Repo name is required.'); process.exit(1); }

  // 5. Create private repo on GitHub
  process.stdout.write(`\n→ Creating private repo ${owner}/${repoName}...`);
  let repo;
  const createUrl = owner === user.login
    ? 'https://api.github.com/user/repos'
    : `https://api.github.com/orgs/${owner}/repos`;
  try {
    repo = await ghFetch(createUrl, token, {
      method: 'POST',
      body: JSON.stringify({
        name: repoName,
        private: true,
        auto_init: true,
        description: 'teamctx context data',
      }),
    });
    process.stdout.write(' done.\n');
  } catch (err) {
    console.error(`\nFailed to create repo: ${err.message}`);
    if (err.message.includes('not accessible')) {
      console.error('The token needs "repo" scope (classic PAT) or org admin permissions.');
    }
    process.exit(1);
  }

  // 5. Clone repo locally
  const defaultDir = join(process.cwd(), repoName);
  const localPath = await ask('Clone to', defaultDir);

  if (existsSync(localPath)) {
    console.error(`\nDirectory already exists: ${localPath}`);
    process.exit(1);
  }

  process.stdout.write(`\n→ Cloning into ${localPath}...`);
  // Token embedded in URL — stays in local .git/config only, never committed
  const authUrl = repo.clone_url.replace('https://', `https://${token}@`);
  try {
    await execFileAsync('git', ['clone', authUrl, localPath]);
    process.stdout.write(' done.\n');
  } catch (err) {
    console.error(`\nClone failed: ${err.stderr || err.message}`);
    process.exit(1);
  }

  // 6. cd in and run teamctx init
  process.chdir(localPath);

  const rawBase = `https://raw.githubusercontent.com/${owner}/${repoName}/main`;
  console.log(`\n→ Initializing teamctx. When prompted for:\n`);
  console.log(`   Vercel deploy URL      → your deployed web app URL`);
  console.log(`   GitHub raw base URL    → ${rawBase}`);
  console.log(`   Manager email          → your email\n`);

  await initCommand();

  // 7. Print Vercel env var values
  console.log('\n─────────────────────────────────────────────────────────');
  console.log('Add these env vars to your Vercel project, then redeploy:');
  console.log('─────────────────────────────────────────────────────────');
  console.log(`  GITHUB_REPO      ${owner}/${repoName}`);
  console.log(`  GITHUB_RAW_BASE  ${rawBase}`);
  console.log(`  GITHUB_TOKEN     [the token you entered above]`);
  console.log('─────────────────────────────────────────────────────────\n');
}
