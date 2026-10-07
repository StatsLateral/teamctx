import { describe, it, expect } from 'vitest';
import { assistantPlan } from './assistant-actions.js';

const prompts = { short: 'Tell me about 3.2 & "more"', full: 'The whole approved context…' };

describe('Claude', () => {
  it('opens with the short prompt in the link when the assistant is connected', () => {
    const plan = assistantPlan('claude', 'connected', prompts);
    expect(plan.open).toBe(`https://claude.ai/new?q=${encodeURIComponent(prompts.short)}`);
    expect(plan.copy).toBeUndefined();
    expect(new URL(plan.open).searchParams.get('q')).toBe(prompts.short);
  });

  it('copies the full prompt and opens an empty chat in paste mode: it is too long for a link', () => {
    const plan = assistantPlan('claude', 'paste', prompts);
    expect(plan).toEqual({ copy: prompts.full, open: 'https://claude.ai/new', toast: 'Prompt copied. Paste it into Claude.' });
  });
});

describe('ChatGPT', () => {
  it('opens with the short prompt in the link when the assistant is connected', () => {
    const plan = assistantPlan('chatgpt', 'connected', prompts);
    expect(new URL(plan.open).origin).toBe('https://chatgpt.com');
    expect(new URL(plan.open).searchParams.get('q')).toBe(prompts.short);
    expect(plan.copy).toBeUndefined();
  });

  it('copies the full prompt and opens an empty chat in paste mode', () => {
    expect(assistantPlan('chatgpt', 'paste', prompts)).toEqual({ copy: prompts.full, open: 'https://chatgpt.com/', toast: 'Prompt copied. Paste it into ChatGPT.' });
  });
});

describe('Copilot, which cannot be prefilled by link', () => {
  it('copies first and then opens, whichever mode: the short prompt when connected', () => {
    expect(assistantPlan('copilot', 'connected', prompts)).toEqual({ copy: prompts.short, open: 'https://copilot.microsoft.com/', toast: 'Prompt copied. Paste it into Copilot.' });
  });

  it('copies the full prompt in paste mode', () => {
    expect(assistantPlan('copilot', 'paste', prompts).copy).toBe(prompts.full);
  });

  it('never puts the prompt in the address', () => {
    for (const mode of ['connected', 'paste']) expect(assistantPlan('copilot', mode, prompts).open).not.toContain('?');
  });
});

describe('the copy button', () => {
  it('copies the full prompt in either mode, and opens nothing', () => {
    for (const mode of ['connected', 'paste']) {
      expect(assistantPlan('copy', mode, prompts)).toEqual({ copy: prompts.full, toast: 'Prompt copied.' });
    }
  });
});

describe('the function the page script is built from', () => {
  it('stands alone: its source runs with nothing else in scope', () => {
    const rebuilt = new Function(`return (${assistantPlan.toString()});`)();
    expect(rebuilt('claude', 'connected', prompts)).toEqual(assistantPlan('claude', 'connected', prompts));
  });
});
