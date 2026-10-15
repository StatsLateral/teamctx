import { describe, it, expect } from 'vitest';
import { connectCheck, connectedPrompt } from './prompts.js';
import { promptFor } from './views/prompt-for.js';

describe('a connected prompt in a chat with no teamctx tools', () => {
  it('tells the assistant to name the missing connector instead of guessing', () => {
    const check = connectCheck('acme', 'gtm');
    expect(check).toMatch(/no teamctx tools in this chat/);
    expect(check).toMatch(/connector for acme\/gtm is not turned on/);
    expect(check).toMatch(/Paste the context in/);
  });

  it('is in every connected prompt', () => {
    expect(connectedPrompt({ owner: 'acme', repo: 'gtm', subject: 'x', scope: 'y' })).toContain('not turned on in this chat');
    const task = promptFor({ node: { text: 'Do it', key: '1.2' }, tier: 'task', where: 'Part', isProject: false, owner: 'acme', repo: 'gtm' });
    expect(task).toContain('not turned on in this chat');
  });
});
