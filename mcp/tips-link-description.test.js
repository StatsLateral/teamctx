import { describe, it, expect } from 'vitest';
import { TOOLS } from './server.js';

describe('the tool descriptions that ask for the project link', () => {
  it('ask for the Tips & Tricks link beneath it, which is where an assistant takes its instruction from', () => {
    const linked = TOOLS.filter(t => /viewUrl/.test(t.description || ''));
    expect(linked.length).toBeGreaterThanOrEqual(7);
    for (const t of linked) {
      expect(t.description, t.name).toMatch(/directly beneath it `tipsUrl` \(the Tips & Tricks page\)/);
    }
  });
});
