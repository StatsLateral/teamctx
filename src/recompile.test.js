/**
 * A project-level change reaching pages that were already compiled.
 *
 * Inheritance is concatenation at compile time, but a compiled page is written
 * once and then sits there. So a contribution to the project landed correctly
 * and every workstream's page went on showing the project as it was before —
 * and that page is what a member reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./storage.js', () => ({
  listWorkstreamIds: vi.fn(() => ['delivery', 'docs']),
  readWorkstream: vi.fn(id => ({ id, name: id, whys: [] })),
  writeWorkstreamMd: vi.fn(),
}));
vi.mock('./context.js', () => ({ serializeToMd: vi.fn(() => '# md') }));

const { recompileInheritors } = await import('./recompile.js');
const { listWorkstreamIds, writeWorkstreamMd } = await import('./storage.js');
const { serializeToMd } = await import('./context.js');

const PROJECT = { name: 'Ledger', whys: [{ id: 'p1', text: 'no new vendors' }] };
const config = {
  project: 'Ledger',
  workstreams: [{ id: 'delivery', name: 'Delivery' }, { id: 'docs', name: 'Documentation' }],
};

beforeEach(() => vi.clearAllMocks());

describe('pushing a changed project into the compiled pages', () => {
  it('rewrites every workstream page', () => {
    recompileInheritors({ project: PROJECT, config, teamctxDir: '/x' });
    expect(writeWorkstreamMd.mock.calls.map(c => c[0])).toEqual(['delivery', 'docs']);
  });

  it('gives each one the new project tree as its inherited half', () => {
    recompileInheritors({ project: PROJECT, config, teamctxDir: '/x' });
    serializeToMd.mock.calls.forEach(call => {
      expect(call[4].project).toBe(PROJECT);
    });
  });

  it('titles each page the way a person named it, not by its id', () => {
    recompileInheritors({ project: PROJECT, config, teamctxDir: '/x' });
    expect(serializeToMd.mock.calls.map(c => c[1])).toEqual(['Delivery', 'Documentation']);
  });

  it('falls back to the id for a workstream the config does not name', () => {
    recompileInheritors({ project: PROJECT, config: { project: 'Ledger' }, teamctxDir: '/x' });
    expect(serializeToMd.mock.calls[0][1]).toBe('delivery');
  });

  it('does nothing on a project with no workstreams', () => {
    listWorkstreamIds.mockReturnValue([]);
    expect(recompileInheritors({ project: PROJECT, config, teamctxDir: '/x' })).toEqual([]);
    expect(writeWorkstreamMd).not.toHaveBeenCalled();
  });
});
