import { GoogleGenAI } from '@google/genai';
import { getRequestAiKey } from '../ai-context.js';
import { missingKeyMessage } from './missing-key.js';

export const id = 'gemini';

export async function complete({ system = '', prompt, model, max_tokens = 4096 }) {
  const apiKey = getRequestAiKey() || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(missingKeyMessage('GEMINI_API_KEY', 'Gemini'));
  }
  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model,
    contents: prompt,
    config: {
      ...(system ? { systemInstruction: system } : {}),
      maxOutputTokens: max_tokens,
    },
  });
  return (response.text || '').trim();
}
