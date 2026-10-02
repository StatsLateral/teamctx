import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../src/prefs.js', () => ({ resolveDisplayName: vi.fn(async () => 'Priya') }));
const { buildBrief } = await import('./brief.core.js');
const { writeConfig, writeProject, writeTreeMd } = await import('../../src/storage.js');

describe('my_brief is read when it is asked for', () => {
  it('leaves out an exception that has expired, though nothing was contributed since', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-brief-'));
    mkdirSync(join(dir, 'workstreams'));
    writeConfig({ project: 'Party', workstreams: [], roles: [], members: [] }, dir);
    writeProject({ name: 'Party', goal: { text: 'A relaxed party' }, tasks: [], records: [
      { id: 'r1', type: 'rule', text: 'No nuts', status: 'active', attachedTo: { kind: 'project' }, links: {} },
      { id: 'e1', type: 'exception', text: 'Frosting on the adults cake', status: 'active', expiresAt: '2000-01-01', attachedTo: { kind: 'project' }, links: { bends: 'r1' } },
    ] }, dir);
    // A page compiled back when the exception still held.
    writeTreeMd(null, 'Allowed: Frosting on the adults cake (until 2000-01-01, instead of: No nuts)', dir);
    const r = await buildBrief({ teamctxDir: dir, actor: { key: 'git:p@x', name: 'Priya' } });
    const text = r.context.map(c => c.markdown).join('\n');
    expect(text).toContain('Rule: No nuts');
    expect(text).not.toContain('Frosting');
  });
});
