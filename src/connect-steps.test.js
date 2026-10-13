import { describe, it, expect } from 'vitest';
import { CHATBOTS, stepsAsPromptText } from './connect-steps.js';
import { connectCheck } from './prompts.js';
import { assistantBlockHtml } from './views/drawers.js';

const ADDRESS = 'https://teamctx.vercel.app/api/mcp/acme/gtm';

describe('how to turn the connector on', () => {
  it('names the exact address to paste, for the chatbots that take one', () => {
    const text = stepsAsPromptText(ADDRESS);
    expect(text.match(new RegExp(ADDRESS.replace(/[/.]/g, '\\$&'), 'g'))).toHaveLength(2);
  });

  it('says where to find the address when the page was not given one', () => {
    expect(stepsAsPromptText(null)).toContain('connector address shown under Settings');
  });

  it('is in the prompt, with the instruction to give only the assistant\'s own', () => {
    const check = connectCheck('acme', 'gtm', 'https://teamctx.vercel.app');
    expect(check).toContain(ADDRESS);
    expect(check).toMatch(/for the chatbot you are, only that one/);
    for (const bot of CHATBOTS) expect(check).toContain(`${bot.name}:`);
  });

  it('is on the page beside the buttons, for each chatbot', () => {
    const html = assistantBlockHtml({ view: { owner: 'acme', repo: 'gtm' }, origin: 'https://teamctx.vercel.app' });
    expect(html).toContain('How to turn the connector on');
    for (const bot of CHATBOTS) expect(html).toContain(bot.name);
    expect(html).toContain(ADDRESS);
  });
});
