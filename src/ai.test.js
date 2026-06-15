import { describe, expect, it, vi } from 'vitest';
import { callClaude, extractJson } from './ai.js';

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"result":"ok"}' }],
      }),
    },
  })),
}));

describe('extractJson', () => {
  it('parses raw JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips bare ``` fences', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('slices to outermost braces when prose precedes JSON', () => {
    expect(extractJson('Here:\n{"x":"y"}\nDone.')).toEqual({ x: 'y' });
  });

  it('throws on empty input', () => {
    expect(() => extractJson('')).toThrow(/empty/i);
  });

  it('throws when no JSON object present', () => {
    expect(() => extractJson('no json here')).toThrow(/json/i);
  });

  it('repairs JSON with a trailing comma', () => {
    expect(extractJson('{"a":1,"b":[1,2,3,],}')).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it('repairs JSON with missing comma between objects', () => {
    expect(extractJson('{"ops":[{"x":1}{"y":2}]}')).toEqual({ ops: [{ x: 1 }, { y: 2 }] });
  });
});

describe('callClaude', () => {
  it('throws a clear error when ANTHROPIC_API_KEY is not set', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(callClaude({ prompt: 'test' })).rejects.toThrow(/ANTHROPIC_API_KEY/i);
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });

  it('returns text content from the mocked SDK response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const result = await callClaude({ prompt: 'hello' });
    expect(result).toBe('{"result":"ok"}');
  });
});
