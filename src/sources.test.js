import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanRef, cleanLink, connectorKey, recordSources, visibleSources, sourceId, TITLE_MAX, SUMMARY_MAX } from './sources.js';
import { readSourceRefs, readApprovals } from './storage.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'teamctx-sources-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const maya = { name: 'Maya', key: 'git:maya@x' };
const thread = { connector: 'slack', title: '#launch: pricing thread', link: 'https://acme.slack.com/archives/C1/p1700000000000100', summary: 'Agreed seat pricing' };
const files = () => readdirSync(join(dir, 'sources')).map(f => readFileSync(join(dir, 'sources', f), 'utf-8')).join('\n');

describe('a source reference', () => {
  it('keeps the tool, the item, a link and a short summary, and nothing else', () => {
    const r = cleanRef({ ...thread, text: 'THE WHOLE THREAD BODY', content: 'more body', token: 'xoxb-secret', id: 'mine' });
    expect(r).toEqual({ id: sourceId('slack', thread.link), connector: 'slack', title: thread.title, link: thread.link, summary: 'Agreed seat pricing' });
  });

  it('cuts a long title and summary, and folds them to one line', () => {
    const r = cleanRef({ connector: 'notion', title: `a\n${'t'.repeat(500)}`, summary: 's'.repeat(900) });
    expect(r.title).toHaveLength(TITLE_MAX);
    expect(r.title.startsWith('a t')).toBe(true);
    expect(r.summary).toHaveLength(SUMMARY_MAX);
  });

  it('needs a link or a title to point at anything', () => {
    expect(cleanRef({ connector: 'slack', summary: 'only words' })).toBeNull();
    expect(cleanRef(null)).toBeNull();
    expect(cleanRef('slack')).toBeNull();
  });

  it('keeps two items that share a title apart when the tool says they are different', () => {
    const a = cleanRef({ connector: 'notion', title: 'Meeting notes', itemId: 'notion:1' });
    const b = cleanRef({ connector: 'notion', title: 'Meeting notes', itemId: 'notion:2' });
    expect(a.id).not.toBe(b.id);
    expect(a.itemId).toBe('notion:1');
  });

  it('knows the tools by the names an assistant uses, and puts the rest under other', () => {
    expect(['Google Drive', 'SharePoint', 'OneDrive', 'Microsoft 365', 'NOTION', 'coda', 'Jira'].map(connectorKey))
      .toEqual(['gdrive', 'm365', 'm365', 'm365', 'notion', 'coda', 'other']);
  });
});

describe('a link that is safe to keep', () => {
  it('drops a user, a password and any parameter that carries a credential', () => {
    expect(cleanLink('https://bob:hunter2@docs.example.com/d/1?usp=sharing&access_token=abc&X-Amz-Signature=zz&sig=1&code=9&refresh_token=r'))
      .toBe('https://docs.example.com/d/1?usp=sharing');
    expect(cleanLink('https://app.example.com/cb#access_token=abc')).toBe('https://app.example.com/cb');
  });

  it('keeps what a shared link needs to open', () => {
    const dropbox = 'https://www.dropbox.com/scl/fi/x/doc.pdf?rlkey=abc&dl=0';
    const drive = 'https://drive.google.com/file/d/1x/view?resourcekey=0-abc';
    expect(cleanLink(dropbox)).toBe(dropbox);
    expect(cleanLink(drive)).toBe(drive);
  });

  it('refuses anything that is not http or https', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'not a link', '', 42]) expect(cleanLink(bad)).toBeNull();
  });
});

describe('recording references', () => {
  it('writes one file per item; who brought it, when and what it said go on the feed', () => {
    const [id] = recordSources([thread], { by: maya, at: '2026-10-09T09:00:00.000Z', feed: { workstream: 'sales', contribution: 'c1' }, dir });
    expect(readSourceRefs(dir)[id]).toEqual({
      id, connector: 'slack', title: thread.title, link: thread.link, firstReadAt: '2026-10-09T09:00:00.000Z',
      feeds: [{ workstream: 'sales', contribution: 'c1', at: '2026-10-09T09:00:00.000Z', by: maya, summary: 'Agreed seat pricing', via: 'assistant' }],
    });
  });

  it('adds what an item read again feeds, and never loses what an earlier contribution said', () => {
    recordSources([thread], { by: maya, at: '2026-10-09T09:00:00.000Z', feed: { workstream: 'sales', contribution: 'c1' }, dir });
    const [id] = recordSources([{ ...thread, summary: undefined }], {
      by: { name: 'Dev', key: 'git:dev@x' }, at: '2026-10-10T09:00:00.000Z', via: 'import', summary: 'A plan about something else',
      feed: { workstream: 'ops', contribution: 'c2', task: 't9' }, dir,
    });
    // The same contribution again replaces its own feed rather than adding one.
    recordSources([thread], { by: maya, at: '2026-10-11T09:00:00.000Z', feed: { workstream: 'ops', contribution: 'c2', task: 't9' }, dir });
    const r = readSourceRefs(dir)[id];
    expect(r.firstReadAt).toBe('2026-10-09T09:00:00.000Z');
    expect(r.feeds.map(f => [f.contribution, f.summary])).toEqual([['c1', 'Agreed seat pricing'], ['c2', 'Agreed seat pricing']]);
  });

  it('takes the contribution summary only for an item that brought none', () => {
    const [id] = recordSources([{ connector: 'notion', title: 'Plan' }], { summary: 'What the contribution says', feed: { contribution: 'c1' }, dir });
    expect(readSourceRefs(dir)[id].feeds[0].summary).toBe('What the contribution says');
  });

  it('never writes a body or a secret it was handed', () => {
    recordSources([{ ...thread, link: `${thread.link}?token=xoxb-123`, text: 'BODY-OF-THE-THREAD', password: 'pw-1' }],
      { by: maya, feed: { workstream: null, contribution: 'c1' }, dir });
    const written = files();
    for (const leak of ['xoxb-123', 'BODY-OF-THE-THREAD', 'pw-1']) expect(written).not.toContain(leak);
  });

  it('records nothing without a contribution to feed, or for a list that is not one, and caps a contribution at twenty', () => {
    expect(recordSources([thread], { feed: {}, dir })).toEqual([]);
    expect(recordSources('slack', { feed: { contribution: 'c' }, dir })).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => ({ connector: 'notion', title: `Page ${i}` }));
    expect(recordSources(many, { feed: { contribution: 'c' }, dir })).toHaveLength(20);
  });
});

describe('who sees what of a reference', () => {
  const f = (workstream, contribution, at, summary, name = 'Maya') => ({ workstream, contribution, at, summary, by: { name, key: `k:${name}` } });
  const records = {
    a: { id: 'a', title: 'Sales thread', feeds: [f('sales', 'c1', '2026-10-09', 'Sales view'), f('reorg', 'c2', '2026-10-12', 'Reorg plan, secret', 'Boss')] },
    b: { id: 'b', title: 'Ops doc', feeds: [f('ops', 'c3', '2026-10-10', 'Ops')] },
    c: { id: 'c', title: 'Project brief', feeds: [f(null, 'c4', '2026-10-08', 'Brief')] },
  };

  it('shows a reader only what feeds their parts, and only what those feeds said', () => {
    const seen = visibleSources(records, { canSee: ws => ws === 'sales' });
    expect(seen.map(r => r.id)).toEqual(['a', 'c']);
    expect(seen[0]).toMatchObject({ summary: 'Sales view', lastReadAt: '2026-10-09', by: { name: 'Maya' } });
    expect(JSON.stringify(seen)).not.toMatch(/Reorg|Boss|secret/);
  });

  it('counts only the feeds the caller says count', () => {
    const seen = visibleSources(records, { counts: x => x.contribution !== 'c3' });
    expect(seen.map(r => r.id)).toEqual(['a', 'c']);
  });

  it('shows everything, newest first, to a reader who can see everything', () => {
    const seen = visibleSources(records);
    expect(seen.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(seen[0]).toMatchObject({ summary: 'Reorg plan, secret', lastReadAt: '2026-10-12' });
  });
});

describe('reading the folders anybody with write access can edit', () => {
  it('skips a file that is not valid, or not an object with an id', () => {
    mkdirSync(join(dir, 'approved'), { recursive: true });
    writeFileSync(join(dir, 'approved', 'bad.json'), '{nope');
    writeFileSync(join(dir, 'approved', 'null.json'), 'null');
    writeFileSync(join(dir, 'approved', 'ok.json'), JSON.stringify({ id: 'c1', approvedAt: 'x' }));
    expect(Object.keys(readApprovals(dir))).toEqual(['c1']);
  });
});
