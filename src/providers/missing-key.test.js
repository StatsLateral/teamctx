import { describe, it, expect } from 'vitest';
import { missingKeyMessage } from './missing-key.js';
import { runWithSession } from '../session-context.js';

describe('what someone is told when no AI key is available', () => {
  it('names the env file on a laptop', () => {
    const m = missingKeyMessage('ANTHROPIC_API_KEY', 'Anthropic');
    expect(m).toMatch(/\.env file/);
  });

  it('never names an env file on the hosted server', async () => {
    // A member reaching the project through a chat client has no file and no
    // shell. Acting on that advice means asking whoever runs the server to set
    // a process-wide key — which would put every project on one credential.
    await runWithSession({ owner: 'acme', repo: 'ledger' }, async () => {
      const m = missingKeyMessage('ANTHROPIC_API_KEY', 'Anthropic');
      expect(m).not.toMatch(/\.env file/);
      expect(m).not.toMatch(/shell environment/);
    });
  });

  it('points at the two places a hosted key can come from', async () => {
    await runWithSession({ owner: 'acme', repo: 'ledger' }, async () => {
      const m = missingKeyMessage('ANTHROPIC_API_KEY', 'Anthropic');
      expect(m).toMatch(/\/settings/);
      expect(m).toMatch(/share one with the project/);
    });
  });

  it('says outright that a server-wide key is not the fix', async () => {
    // This is the advice an assistant reaches for on its own, and following it
    // is worse than the problem.
    await runWithSession({ owner: 'acme', repo: 'ledger' }, async () => {
      expect(missingKeyMessage('ANTHROPIC_API_KEY', 'Anthropic')).toMatch(/is not the fix/);
    });
  });
});
