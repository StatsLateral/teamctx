import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isSlackWebhook, slackMessage, postToSlack, slackWebhookFor, announceQueued } from './slack-notify.js';
import { kvSet, keys, __resetMemory } from './oauth/kv.js';
import { runWithSession } from './session-context.js';

const HOOK = 'https://hooks.slack.com/services/T000/B000/XXXXSECRET';
const ok = () => vi.fn(async () => ({ ok: true, status: 200 }));

beforeEach(() => __resetMemory());

describe('which addresses are accepted', () => {
  it('a Slack incoming webhook only', () => {
    expect(isSlackWebhook(HOOK)).toBe(true);
    for (const bad of ['http://hooks.slack.com/services/T/B/X', 'https://hooks.slack.com.evil.io/services/T/B/X',
      'https://example.com/services/T/B/X', 'https://evilhooks.slack.com/services/T/B/X', 'https://hooks.slack.com/other', 'https://u:p@hooks.slack.com/services/T/B/X', 'not a url', '']) {
      expect(isSlackWebhook(bad), bad).toBe(false);
    }
  });
});

describe('the message', () => {
  it('holds the number, the sender, a one-line summary and the link, and nothing else', () => {
    const m = slackMessage({ number: '3.2', author: 'Priya', summary: 'Submitted: pricing draft\nsecond line', link: 'https://t.example/project/a/b?review=c-1' });
    expect(m).toEqual({ text: 'Waiting for your approval: *3.2* Submitted: pricing draft — from Priya\n<https://t.example/project/a/b?review=c-1|Open it>' });
  });

  it('reads markup in a summary as text', () => {
    expect(slackMessage({ author: 'A & B', summary: 'use <!channel> > all' }).text)
      .toBe('Waiting for your approval: use &lt;!channel&gt; &gt; all — from A &amp; B');
  });
});

describe('posting', () => {
  it('posts the message as JSON to the webhook', async () => {
    const fetchImpl = ok();
    expect(await postToSlack(HOOK, { text: 'hi' }, { fetchImpl })).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(HOOK, expect.objectContaining({ method: 'POST', body: '{"text":"hi"}' }));
  });

  it('says why it failed, never with the address, and never throws', async () => {
    const r404 = await postToSlack(HOOK, { text: 'hi' }, { fetchImpl: vi.fn(async () => ({ ok: false, status: 404 })) });
    expect(r404).toEqual({ ok: false, why: 'Slack answered 404' });
    const down = await postToSlack(HOOK, { text: 'hi' }, { fetchImpl: vi.fn(async () => { throw new Error(`getaddrinfo ENOTFOUND ${HOOK}`); }) });
    expect(down.why).toBe('Slack could not be reached');
  });

  it('gives up on a webhook that does not answer', async () => {
    const hangs = vi.fn(() => new Promise(() => {}));
    const r = await postToSlack(HOOK, { text: 'hi' }, { fetchImpl: hangs, timeoutMs: 20 });
    expect(r).toEqual({ ok: false, why: 'Slack did not answer within 0.02s' });
  });

  it('does not post to an address that is not Slack', async () => {
    const fetchImpl = ok();
    expect((await postToSlack('https://example.com/x', { text: 'hi' }, { fetchImpl })).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('where the webhook is read from', () => {
  it('the environment, on the command line', async () => {
    expect(await slackWebhookFor({ env: { TEAMCTX_SLACK_WEBHOOK: ` ${HOOK} ` } })).toBe(HOOK);
    expect(await slackWebhookFor({ env: {} })).toBeNull();
  });

  it('the store, for a hosted project, and never the environment there', async () => {
    await kvSet(keys.slackWebhook('acme', 'shop'), { url: HOOK, setBy: 'm@x', setAt: 'now' });
    const session = { owner: 'acme', repo: 'shop' };
    expect(await runWithSession(session, () => slackWebhookFor({ env: { TEAMCTX_SLACK_WEBHOOK: 'https://hooks.slack.com/services/other' } }))).toBe(HOOK);
    expect(await runWithSession({ owner: 'acme', repo: 'other' }, () => slackWebhookFor({ env: { TEAMCTX_SLACK_WEBHOOK: HOOK } }))).toBeNull();
  });
});

describe('announcing a queued item', () => {
  const item = { id: 'mcp-1-abc', number: '3.2', author: 'Priya', summary: 'Submitted: pricing draft', text: 'THE FULL TEXT' };

  it('links to the item\'s drawer and leaves its text out', async () => {
    await kvSet(keys.slackWebhook('acme', 'shop'), { url: HOOK });
    const fetchImpl = ok();
    const r = await runWithSession({ owner: 'acme', repo: 'shop' }, () => announceQueued(item, { baseUrl: 'https://t.example', fetchImpl }));
    expect(r).toEqual({ sent: true });
    const body = fetchImpl.mock.calls[0][1].body;
    expect(JSON.parse(body).text).toContain('<https://t.example/project/acme/shop?review=mcp-1-abc|Open it>');
    expect(body).not.toContain('THE FULL TEXT');
  });

  it('does nothing when no webhook is set', async () => {
    const fetchImpl = ok();
    expect(await announceQueued(item, { env: {}, fetchImpl })).toEqual({ sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('logs a failure without the address', async () => {
    const log = vi.fn();
    const r = await announceQueued(item, { env: { TEAMCTX_SLACK_WEBHOOK: HOOK }, pushed: true, fetchImpl: vi.fn(async () => ({ ok: false, status: 500 })), log });
    expect(r).toEqual({ sent: false });
    expect(log).toHaveBeenCalledWith('Slack: the notice for mcp-1-abc was not sent: Slack answered 500.');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });
});
