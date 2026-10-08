import { describe, it, expect } from 'vitest';
import { workHtml } from './project-work.js';
import { panelsHtml } from './drawers.js';
import { drawerPrompts } from '../prompts.js';

const ws = (id, number, name, parent = null) => ({ id, number, name, parent });
const view = (over = {}) => ({
  project: 'Ledger', owner: 'acme', repo: 'ledger', agents: [],
  workstreams: [ws('a', 1, 'First article'), ws('b', 2, 'Second article'), ws('c', 3, 'Third article')],
  tasks: { open: [], done: [] }, pending: [],
  projectTree: { goal: { text: 'Ship it' }, records: [], tasks: [] },
  trees: { a: { id: 'a', records: [], tasks: [] }, b: { id: 'b', records: [], tasks: [] }, c: { id: 'c', records: [], tasks: [] } },
  ...over,
});
const task = (id, workstream, title, status = 'open') => ({ id, workstream, title, status, key: `${workstream}.1`, sourceContributionIds: [] });
const render = (v, selected = null, extra = {}) => workHtml({ view: v, selected, item: null, history: false, origin: null, base: '/project/acme/ledger', ...extra }).main;

describe('a workstream with no tasks is still on the page', () => {
  it('lists every workstream under Overall Project, with or without tasks', () => {
    const html = render(view({ tasks: { open: [task('t1', 'b', 'Write the draft')], done: [] } }));
    expect(html.match(/class="wsec"/g)).toHaveLength(3);
    for (const name of ['First article', 'Second article', 'Third article']) expect(html).toContain(name);
    expect(html).toContain('Write the draft');
  });

  it('says so plainly where there are no tasks, and offers to create them', () => {
    const html = render(view());
    expect(html.match(/No tasks found in this workstream/g)).toHaveLength(3);
    expect(html.match(/data-intent="tasks"/g)).toHaveLength(3);
    expect(html).toContain('Create new tasks');
  });

  it('points the button at that workstream\'s own drawer', () => {
    const html = render(view());
    expect(html).toMatch(/data-panel="dp-ws-b"[^>]*data-intent="tasks"|data-intent="tasks"[^>]*data-panel="dp-ws-b"/);
  });

  it('does not show the empty message for a workstream that has tasks', () => {
    const html = render(view({ tasks: { open: [task('t1', 'a', 'Write the draft')], done: [] } }), 'a');
    expect(html).toContain('Write the draft');
    expect(html).not.toContain('No tasks found');
  });

  it('shows it for a selected workstream with none, and for one holding only finished work', () => {
    expect(render(view(), 'c')).toContain('No tasks found in this workstream');
    const doneOnly = render(view({ tasks: { open: [], done: [task('t1', 'a', 'Old thing', 'done')] } }), 'a');
    expect(doneOnly).toMatch(/No open tasks in this workstream/);
    expect(doneOnly).toContain('Create new tasks');
  });

  it('keeps the no-work message for a project with no workstreams at all', () => {
    expect(render(view({ workstreams: [], trees: {} }))).toContain('No work yet');
  });
});

describe('the drawer the button opens', () => {
  it('has a prompt for thinking about tasks, specific to that workstream', () => {
    const p = drawerPrompts({ view: view() }).ws.b.tasks;
    expect(p.short).toContain('Second article');
    expect(p.short).toMatch(/tasks/i);
    expect(p.short).toMatch(/ask me which|which .* to add/i);
    expect(p.full).toContain('Second article');
    expect(p.full).toMatch(/tasks/i);
  });

  it('asks for work a person would pick up, and nothing added without a yes', () => {
    const { short } = drawerPrompts({ view: view() }).ws.a.tasks;
    expect(short).toMatch(/person/i);
    expect(short).toMatch(/only (the ones|those) I (choose|confirm|pick)/i);
  });

  it('says in the drawer why it is open', () => {
    expect(panelsHtml({ view: view(), onDay: '2026-10-08' })).toContain('data-for="tasks"');
  });
});
