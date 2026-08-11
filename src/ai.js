import { jsonrepair } from 'jsonrepair';
import { getProvider } from './providers/index.js';
import { getRequestAiProvider } from './ai-context.js';

export const MODELS_BY_PROVIDER = {
  anthropic: [
    { id: 'claude-opus-4-7', label: 'Opus 4.7 — sharpest' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — balanced' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fast' },
  ],
  openai: [
    { id: 'gpt-4.1', label: 'GPT-4.1 — sharpest' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini — balanced' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini — fast' },
  ],
  gemini: [
    { id: 'gemini-pro-latest', label: 'Gemini Pro (latest) — sharpest' },
    { id: 'gemini-flash-latest', label: 'Gemini Flash (latest) — balanced' },
  ],
};

export const DEFAULT_MODEL_BY_PROVIDER = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4.1-mini',
  gemini: 'gemini-flash-latest',
};

export const FAST_MODEL_BY_PROVIDER = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-flash-latest',
};

export function getModelsFor(providerId) {
  return MODELS_BY_PROVIDER[providerId] || [];
}

export function getDefaultModelFor(providerId) {
  return DEFAULT_MODEL_BY_PROVIDER[providerId];
}

export function getFastModelFor(providerId) {
  return FAST_MODEL_BY_PROVIDER[providerId];
}

export const MODELS = MODELS_BY_PROVIDER.anthropic;
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.anthropic;

export async function callClaude({ prompt, model = DEFAULT_MODEL, system = '', max_tokens = 4096, config }) {
  // A per-user key (hosted mode) belongs to a specific provider, which need not
  // be the one named in the project's shared config. The key wins, and the model
  // follows it — otherwise an OpenAI key gets sent a Claude model id.
  const requestProvider = getRequestAiProvider();
  const effectiveConfig = requestProvider ? { ...config, provider: requestProvider } : config;
  const provider = getProvider(effectiveConfig);
  const effectiveModel = requestProvider && requestProvider !== (config?.provider || 'anthropic')
    ? modelForProvider(requestProvider, model)
    : model;
  return provider.complete({ prompt, model: effectiveModel, system, max_tokens });
}

function modelForProvider(providerId, requested) {
  const known = getModelsFor(providerId);
  if (known.some(m => m.id === requested)) return requested;
  return getDefaultModelFor(providerId);
}

export function extractJson(text) {
  if (!text) throw new Error('Empty response from model');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON object found in response');
  const slice = candidate.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return JSON.parse(jsonrepair(slice));
  }
}

function stripWorkstreamForPrompt(workstream) {
  return {
    name: workstream.name,
    whys: (workstream.whys || []).map(why => ({
      id: why.id,
      text: why.text,
      whats: (why.whats || []).map(what => ({
        id: what.id,
        text: what.text,
        hows: (what.hows || []).map(how => ({ id: how.id, text: how.text })),
      })),
    })),
  };
}

/**
 * `intent` shapes how the input is read.
 *
 *   'contribution' — someone typed a deliberate update; every sentence is signal.
 *   'document'     — an imported artifact, mostly prose written for a different
 *                    purpose. Most of it is not durable team context, and the
 *                    distiller has to be told so or it dutifully turns headings
 *                    and meeting dates into Why nodes.
 *
 * `avoid` carries Why texts already proposed earlier in the same import run.
 * Each document is distilled against the same unchanged record, so without it
 * two documents covering the same decision both propose it.
 */
export async function proposeDiff({ workstream, contribution, source, model, config, intent = 'contribution', avoid = [] }) {
  const isDocument = intent === 'document';

  const system = isDocument
    ? 'You extract durable team context from a document into typed edits to a ' +
      'hierarchical Why / What / How record. Output STRICT JSON only — no markdown fences, no commentary.'
    : 'You distill a single team contribution into typed edits to a hierarchical ' +
      'Why / What / How record. Output STRICT JSON only — no markdown fences, no commentary.';

  const label = isDocument ? 'Document' : 'Contribution';

  const prompt = [
    `Workstream: "${workstream.name}"`,
    '',
    'Current record (id + text only):',
    JSON.stringify(stripWorkstreamForPrompt(workstream), null, 2),
    '',
    ...(avoid.length ? [
      'Already proposed earlier in this same import — do NOT restate these:',
      ...avoid.map(t => `- ${t}`),
      '',
    ] : []),
    `${label} (source: ${source}):`,
    `"""${contribution}"""`,
    '',
    'Propose how the record should change. Output STRICT JSON:',
    `{
  "summary": "1-2 sentence description of the change",
  "operations": [
    { "type": "addWhy", "text": "...", "summary": "...",
      "whats": [ { "text": "...", "summary": "...", "hows": [ { "text": "...", "summary": "..." } ] } ] },
    { "type": "addWhat", "parentWhyId": "<existing why id>", "text": "...", "summary": "...",
      "hows": [ { "text": "...", "summary": "..." } ] },
    { "type": "addHow", "parentWhatId": "<existing what id>", "text": "...", "summary": "..." },
    { "type": "editStatement", "id": "<existing id>", "text": "new text", "summary": "..." },
    { "type": "deleteStatement", "id": "<existing id>", "summary": "..." }
  ]
}`,
    '',
    'Rules: Why = 3-8 words action-leaning. What = short phrase. How = specific task.',
    'Use smallest set of ops. Prefer editing over near-duplicate adds.',
    'parentWhyId and parentWhatId MUST exist in the current record. JSON only.',
    ...(isDocument ? [
      '',
      'This is a document, not a deliberate update. Extract only durable team',
      'context — the whys, decisions and constraints that outlive this file.',
      'Ignore document structure (headings, tables of contents, section order)',
      'and one-off details (a single meeting date, names mentioned in passing).',
      'If something is already in the record above, or listed as already',
      'proposed, emit no operation for it rather than a near-duplicate.',
      'If the document carries no durable team context, return an empty',
      'operations array — that is a valid and useful answer.',
    ] : []),
  ].join('\n');

  const raw = await callClaude({ prompt, model, system, config });
  const parsed = extractJson(raw);
  return {
    summary: String(parsed.summary ?? '(no summary)'),
    operations: Array.isArray(parsed.operations) ? parsed.operations : [],
  };
}
