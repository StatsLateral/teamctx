import Anthropic from '@anthropic-ai/sdk';
import { getRequestAiKey } from '../ai-context.js';
import { missingKeyMessage } from './missing-key.js';

export const id = 'anthropic';

export async function complete({ system = '', prompt, model, max_tokens = 4096 }) {
  const apiKey = getRequestAiKey() || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(missingKeyMessage('ANTHROPIC_API_KEY', 'Anthropic'));
  }
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model,
    max_tokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}
