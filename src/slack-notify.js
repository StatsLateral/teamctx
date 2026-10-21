/**
 * Tell the manager in Slack when something is waiting for approval (#182).
 *
 * A manager otherwise learns an item is waiting only by opening the page or
 * asking their assistant. Approving stays in the assistant; this only says
 * there is something to approve.
 *
 * The webhook URL is a credential: anybody holding it can post to that channel.
 * It is read from the deployment's store (hosted) or the environment (command
 * line), and never written to the repository, a log line or a page. Only the
 * item's number, its sender, its one-line summary and its link leave teamctx,
 * never the contribution's text.
 *
 * A post that fails is logged, without the URL, and skipped. It never fails or
 * holds up the contribution it is about.
 */
import { kvGet, keys } from './oauth/kv.js';
import { getCurrentSession } from './session-context.js';
import { buildViewUrl } from './view-url.js';
import { connectorUrl, originRemote } from '../cli/commands/connect.core.js';

export const SLACK_ENV = 'TEAMCTX_SLACK_WEBHOOK';
const TIMEOUT_MS = 3000;
const SUMMARY_MAX = 200;

/**
 * A Slack incoming webhook, and nothing else. The setting can then never be
 * used to make the server post somewhere of the setter's choosing.
 */
export function isSlackWebhook(url) {
  try {
    const u = new URL(String(url || '').trim());
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com' && u.pathname.startsWith('/services/')
      && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Slack reads `&`, `<` and `>` as markup; a summary is text. */
const escapeSlack = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const oneLine = (s) => {
  const line = String(s || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
};

/** The message: the number, who sent it, a one-line summary and the link. Nothing else. */
export function slackMessage({ number = null, author, summary, link = null }) {
  const what = [number ? `*${escapeSlack(number)}*` : null, escapeSlack(oneLine(summary) || 'A contribution')].filter(Boolean).join(' ');
  const from = author ? ` — from ${escapeSlack(oneLine(author))}` : '';
  return { text: `Waiting for your approval: ${what}${from}${link ? `\n<${link}|Open it>` : ''}` };
}

/**
 * Post, and say how it went. Never throws, and gives up after `timeoutMs`. The
 * reason given never carries the URL, since it is logged.
 */
export async function postToSlack(url, message, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!isSlackWebhook(url)) return { ok: false, why: 'the address set is not a Slack incoming webhook' };
  let timer;
  try {
    const controller = new AbortController();
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('timeout'), { timeout: true })); }, timeoutMs);
    });
    const res = await Promise.race([
      fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      }),
      timedOut,
    ]);
    return res.ok ? { ok: true } : { ok: false, why: `Slack answered ${res.status}` };
  } catch (err) {
    return { ok: false, why: err?.timeout ? `Slack did not answer within ${timeoutMs / 1000}s` : 'Slack could not be reached' };
  } finally {
    clearTimeout(timer);
  }
}

/** The webhook for this project: the deployment's store when hosted, the environment otherwise. */
export async function slackWebhookFor({ env = process.env } = {}) {
  const session = getCurrentSession();
  if (session?.owner && session?.repo) {
    const saved = await kvGet(keys.slackWebhook(session.owner, session.repo));
    return saved?.url || null;
  }
  return String(env[SLACK_ENV] || '').trim() || null;
}

/** The link that opens the item's drawer, or null when there is no address to link to. */
async function reviewLink(id, { baseUrl, config, projectDir }) {
  const session = getCurrentSession();
  const deployUrl = baseUrl || config?.deployUrl || '';
  try {
    const where = session?.owner ? { owner: session.owner, repo: session.repo } : { remote: await originRemote(projectDir) };
    const { owner, repo } = connectorUrl({ deployUrl, ...where });
    return buildViewUrl({ base: deployUrl, owner, repo, review: id });
  } catch {
    return null;
  }
}

/**
 * Tell Slack an item is waiting, if a webhook is set. Called after the item is
 * committed, so it never announces one that was not written. On the command
 * line that also means pushed (`pushed`): until then the item is only on this
 * machine, and the link would open a page that does not have it.
 */
export async function announceQueued(item, {
  baseUrl = null, config = null, projectDir, pushed = false, env = process.env, fetchImpl, timeoutMs, log = console.warn,
} = {}) {
  if (!getCurrentSession() && !pushed) return { sent: false };
  let url = null;
  try { url = await slackWebhookFor({ env }); } catch { url = null; }
  if (!url) return { sent: false };
  const link = await reviewLink(item.id, { baseUrl, config, projectDir });
  const posted = await postToSlack(url, slackMessage({ number: item.number, author: item.author, summary: item.summary, link }), { fetchImpl, timeoutMs });
  if (!posted.ok) log(`Slack: the notice for ${item.id} was not sent: ${posted.why}.`);
  return { sent: posted.ok };
}
