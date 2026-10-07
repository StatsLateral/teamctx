import { describe, it, expect } from 'vitest';
import { renderBrief } from './brief.js';
import { makeProject, makeWorkstream, makeRecord, makeTask } from './test-fixtures/model.js';

const ON = '2026-10-02';
const rule = makeRecord({ id: 'rec-rule', type: 'rule', text: 'No nuts anywhere' });
const exc = makeRecord({ type: 'exception', text: 'Chocolate frosting on the adults cake', expiresAt: '2026-10-31', links: { bends: 'rec-rule' } });

describe('renderBrief', () => {
  it('numbers tasks, never records, and leaves the labels as they are', () => {
    const md = renderBrief({ projectName: 'P', onDay: ON, project: makeProject({
      records: [{ ...rule, key: 'R-7' }, { ...exc, key: 'X-2' }],
    }), chain: [makeWorkstream('food', { number: '3', tasks: [makeTask({ key: '3.2', title: 'Shop' })] })] });
    expect(md).toContain('- Rule: No nuts');
    expect(md).toContain('  - Allowed: Chocolate');
    expect(md).toContain('- 3.2 Shop');
    expect(md).toContain('## 3 food');
    expect(md).not.toMatch(/\b[RX]-\d/);
  });
  it('lists no task of the project itself: a task lives in a workstream', () => {
    const md = renderBrief({ projectName: 'P', onDay: ON, project: makeProject({ tasks: [makeTask({ key: '9.9', title: 'Loose' })] }), chain: [] });
    expect(md).not.toContain('Loose');
  });
  it('prints the goal and plain labels, never type names', () => {
    const md = renderBrief({ projectName: 'Party', project: makeProject({ goal: { text: 'A relaxed party', why: 'Family first' }, records: [makeRecord({ type: 'decision', text: 'Banana cake', detail: 'low sugar' })] }), chain: [], onDay: ON });
    expect(md).toContain('A relaxed party');
    expect(md).toContain('Why it matters: Family first');
    expect(md).toContain('We decided: Banana cake — why: low sugar');
    expect(md).not.toMatch(/\b(decision|assumption|exception|rule|question|risk)\b:/);
  });

  it('prints an exception under the rule it bends, and nowhere else', () => {
    const md = renderBrief({ projectName: 'P', project: makeProject({ records: [rule, exc] }), chain: [], onDay: ON });
    const ruleAt = md.indexOf('Rule: No nuts anywhere');
    const excAt = md.indexOf('Allowed: Chocolate frosting');
    expect(ruleAt).toBeGreaterThan(-1);
    expect(excAt).toBeGreaterThan(ruleAt);
    expect(md.split('Allowed: Chocolate frosting')).toHaveLength(2);
    expect(md).toContain('until 2026-10-31');
  });

  it('omits an exception whose rule is not in the brief, replaced, or expired', () => {
    const orphan = renderBrief({ projectName: 'P', project: makeProject({ records: [exc] }), chain: [], onDay: ON });
    expect(orphan).not.toContain('Chocolate frosting');
    const replacedRule = { ...rule, status: 'replaced' };
    expect(renderBrief({ projectName: 'P', project: makeProject({ records: [replacedRule, exc] }), chain: [], onDay: ON })).not.toContain('Chocolate frosting');
    expect(renderBrief({ projectName: 'P', project: makeProject({ records: [rule, exc] }), chain: [], onDay: '2026-11-01' })).not.toContain('Chocolate frosting');
  });

  it('shows review dates, and leaves out inactive records', () => {
    const md = renderBrief({ projectName: 'P', project: makeProject({ records: [
      makeRecord({ type: 'assumption', text: '20 guests', reviewBy: '2026-10-07', owner: { key: 'k', name: 'Maya' } }),
      makeRecord({ type: 'decision', text: 'Old cake', status: 'replaced' }),
    ] }), chain: [], onDay: ON });
    expect(md).toContain("We're assuming: 20 guests (check by 2026-10-07)");
    expect(md).not.toContain('Old cake');
  });

  it('walks the chain from the project down, labelling inherited parts', () => {
    const parent = makeWorkstream('food', { name: 'Food', number: '1', records: [makeRecord({ type: 'decision', text: 'Banana cake' })] });
    const child = makeWorkstream('cake', { name: 'Cake', number: '2', tasks: [makeTask({ key: '2.1', title: 'Bake it', owner: 'Mum' })] });
    const md = renderBrief({ projectName: 'P', project: makeProject({ goal: { text: 'G' } }), chain: [parent, child], onDay: ON });
    expect(md.indexOf('G')).toBeLessThan(md.indexOf('1 Food'));
    expect(md.indexOf('1 Food')).toBeLessThan(md.indexOf('2 Cake'));
    expect(md).toContain('We decided: Banana cake');
    expect(md).toContain('2.1 Bake it — Mum');
  });

  it('prints a record attached to a task once, under its task', () => {
    const t = makeTask({ id: 'task-x', title: 'Bake it' });
    const ws = makeWorkstream('cake', { name: 'Cake', number: '1', tasks: [t], records: [makeRecord({ type: 'decision', text: 'Use bananas', attachedTo: { kind: 'task', id: 'task-x' } })] });
    const md = renderBrief({ projectName: 'P', project: makeProject(), chain: [ws], onDay: ON });
    expect(md.split('We decided: Use bananas')).toHaveLength(2);
    expect(md.indexOf('Bake it')).toBeLessThan(md.indexOf('We decided: Use bananas'));
  });
});
