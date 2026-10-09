import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanRef, cleanLink, connectorKey, recordSources, visibleSources, sourceId, TITLE_MAX, SUMMARY_MAX } from './sources.js';
import { readSourceRefs } from './storage.js';

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

  it('knows the tools by the names an assistant uses, and puts the rest under other', () => {
    expect(['Google Drive', 'SharePoint', 'OneDrive', 'Microsoft 365', 'NOTION', 'coda', 'Jira'].map(connectorKey))
      .toEqual(['gdrive', 'm365', 'm365', 'm365', 'notion', 'coda', 'other']);
  });
});

describe('a link that is safe to keep', () => {
  it('drops a user, a password and any parameter that looks like a credential', () => {
    expect(cleanLink('https://bob:hunter2@docs.example.com/d/1?usp=sharing&access_token=abc&X-Amz-Signature=zz&sig=1&code=9&rlkey=q'))
      .toBe('https://docs.example.com/d/1?usp=sharing');
    expect(cleanLink('https://app.example.com/cb#access_token=abc')).toBe('https://app.example.com/cb');
  });

  it('refuses anything that is not http or https', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'not a link', '', 42]) expect(cleanLink(bad)).toBeNull();
  });
});

describe('recording references', () => {
  it('writes one file per item, with who brought it, when, and what it feeds', () => {
    const [id] = recordSources([thread], { by: maya, at: '2026-10-09T09:00:00.000Z', feed: { workstream: 'sales', contribution: 'c1' }, dir });
    const r = readSourceRefs(dir)[id];
    expect(r).toMatchObject({
      connector: 'slack', title: thread.title, link: thread.link, by: maya, via: 'assistant',
      firstReadAt: '2026-10-09T09:00:00.000Z', lastReadAt: '2026-10-09T09:00:00.000Z',
      feeds: [{ workstream: 'sales', contribution: 'c1' }],
    });
  });

  it('updates an item read again, adding what it feeds and never repeating it', () => {
    recordSources([thread], { by: maya, at: '2026-10-09T09:00:00.000Z', feed: { workstream: 'sales', contribution: 'c1' }, dir });
    const [id] = recordSources([{ ...thread, summary: 'Seat pricing, revised' }], {
      by: { name: 'Dev' }, at: '2026-10-10T09:00:00.000Z', via: 'import', feed: { workstream: 'ops', contribution: 'c2', task: 't9' }, dir,
    });
    recordSources([thread], { by: maya, at: '2026-10-11T09:00:00.000Z', feed: { workstream: 'ops', contribution: 'c2', task: 't9' }, dir });
    const all = readSourceRefs(dir);
    expect(Object.keys(all)).toEqual([id]);
    expect(all[id]).toMatchObject({
      firstReadAt: '2026-10-09T09:00:00.000Z', lastReadAt: '2026-10-11T09:00:00.000Z', by: maya, via: 'both', summary: 'Agreed seat pricing',
      feeds: [{ workstream: 'sales', contribution: 'c1' }, { workstream: 'ops', contribution: 'c2', task: 't9' }],
    });
  });

  it('never writes a body or a secret it was handed', () => {
    recordSources([{ ...thread, link: `${thread.link}?token=xoxb-123`, text: 'BODY-OF-THE-THREAD', password: 'pw-1' }],
      { by: maya, feed: { workstream: null, contribution: 'c1' }, dir });
    const written = files();
    for (const leak of ['xoxb-123', 'BODY-OF-THE-THREAD', 'pw-1']) expect(written).not.toContain(leak);
  });

  it('records nothing for a list that is not one, and caps how many one contribution can carry', () => {
    expect(recordSources('slack', { feed: { contribution: 'c' }, dir })).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => ({ connector: 'notion', title: `Page ${i}` }));
    expect(recordSources(many, { feed: { contribution: 'c' }, dir })).toHaveLength(20);
  });
});

describe('who sees a reference', () => {
  const records = {
    a: { id: 'a', title: 'Sales thread', lastReadAt: '2026-10-09', feeds: [{ workstream: 'sales', contribution: 'c1' }, { workstream: 'ops', contribution: 'c2' }] },
    b: { id: 'b', title: 'Ops doc', lastReadAt: '2026-10-10', feeds: [{ workstream: 'ops', contribution: 'c3' }] },
    c: { id: 'c', title: 'Project brief', lastReadAt: '2026-10-08', feeds: [{ workstream: null, contribution: 'c4' }] },
  };

  it('shows a reader only what feeds the parts they can see, newest first', () => {
    const seen = visibleSources(records, ws => ws === 'sales');
    expect(seen.map(r => r.id)).toEqual(['a', 'c']);
    expect(seen[0].feeds).toEqual([{ workstream: 'sales', contribution: 'c1' }]);
  });

  it('shows everything to a reader who can see everything', () => {
    expect(visibleSources(records).map(r => r.id)).toEqual(['b', 'a', 'c']);
  });
});
