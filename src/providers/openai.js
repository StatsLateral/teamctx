import OpenAI from 'openai';
import { getRequestAiKey } from '../ai-context.js';
import { missingKeyMessage } from './missing-key.js';

export const id = 'openai';

export async function complete({ system = '', prompt, model, max_tokens = 4096 }) {
  const apiKey = getRequestAiKey() || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(missingKeyMessage('OPENAI_API_KEY', 'OpenAI'));
  }
  const client = new OpenAI({ apiKey });
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const response = await client.chat.completions.create({
    model,
    max_completion_tokens: max_tokens,
    messages,
  });
  return (response.choices[0]?.message?.content || '').trim();
}
