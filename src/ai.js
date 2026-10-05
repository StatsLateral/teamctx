import { jsonrepair } from 'jsonrepair';
import { today as todayIso } from './model.js';
import { getProvider } from './providers/index.js';
import { getRequestAiProvider, keyWasRejected, fallBackFromOwnKey } from './ai-context.js';

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
  const attempt = () => {
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
  };
  try {
    return await attempt();
  } catch (err) {
    // Re-worked out from scratch, because the fallback key may belong to a
    // different provider than the one that was rejected.
    if (keyWasRejected(err) && fallBackFromOwnKey()) return attempt();
    throw err;
  }
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

// What the model sees of the current context: active records and tasks, by id,
// so its operations can reference them. Anything no longer active is left out —
// a replaced decision shown to the model is a decision it will repeat.
function modelForPrompt(tree) {
  return {
    goal: tree.goal?.text ?? null,
    records: (tree.records || []).filter(r => r.status === 'active')
      .map(r => ({ id: r.id, ...(r.key ? { key: r.key } : {}), type: r.type, text: r.text, ...(r.links?.bends ? { bends: r.links.bends } : {}) })),
    tasks: (tree.tasks || []).map(t => ({ id: t.id, ...(t.key ? { key: t.key } : {}), title: t.title, status: t.status })),
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
export async function proposeDiff({
  workstream, contribution, source, model, config, intent = 'contribution', avoid = [], today: onDay = todayIso(),
}) {
  const isDocument = intent === 'document';

  const system = isDocument
    ? 'You extract durable team context from a document into typed, governed changes to a ' +
      "team's shared context. Output STRICT JSON only — no markdown fences, no commentary."
    : 'You turn a single team contribution into typed, governed changes to a ' +
      "team's shared context. Output STRICT JSON only — no markdown fences, no commentary.";

  const label = isDocument ? 'Document' : 'Contribution';

  const prompt = [
    `Part of the work: "${workstream.name || 'the project itself'}"`,
    `Today is ${onDay}.`,
    '',
    'Current context (ids you may reference):',
    JSON.stringify(modelForPrompt(workstream), null, 2),
    '',
    ...(avoid.length ? [
      'Already proposed earlier in this same import — do NOT restate these:',
      ...avoid.map(t => `- ${t}`),
      '',
    ] : []),
    `${label} (source: ${source}):`,
    `"""${contribution}"""`,
    '',
    'Propose changes. Output STRICT JSON:',
    'Keys such as D-3 and T-14 are human handles. When a contribution names a key, resolve it to the matching id above. Use internal ids in operations and links; never assign or edit a key.',
    `{
  "summary": "1-2 sentences",
  "operations": [
    { "type": "setGoal", "text": "one line", "why": "why it matters, one line" },
    { "type": "addRecord", "ref": "optional local name", "record": {
        "type": "decision|assumption|rule|exception",
        "text": "one plain sentence", "detail": "the reason, if one was given",
        "owner": { "name": "person" }, "reviewBy": "YYYY-MM-DD", "expiresAt": "YYYY-MM-DD",
        "links": { "bends": "<rule id or ref>", "replaces": "<id>", "restsOn": ["<id>"], "answers": "<question id>" },
        "attachedTo": { "kind": "task", "id": "<task id or ref>" } } },
    { "type": "editRecord", "id": "<existing id>", "changes": { "text": "..." } },
    { "type": "setRecordStatus", "id": "<existing id>", "status": "replaced|broken|closed" },
    { "type": "addTask", "ref": "optional local name", "title": "a concrete piece of work" },
    { "type": "editTask", "id": "<existing task id>", "title": "..." },
    { "type": "removeTask", "id": "<existing task id>" }
  ]
}`,
    '',
    'How to classify: decision = something settled; assumption = believed but unproven (needs owner + reviewBy);',
    'rule = applies until changed; exception = an allowed deviation from ONE rule (needs links.bends naming that rule',
    '+ expiresAt). The reason behind any of them goes in its detail, never in a record of its own. Open questions and',
    'risks are not recorded yet. Concrete work is a task, not a record. Use the smallest set of operations; prefer',
    'editing or replacing over a near-duplicate. If the contribution contradicts an active record, add a question',
    'naming both instead of a second contradictory record. Include attachedTo only when a record is about one',
    'specific task; otherwise leave it out and it belongs to this part of the work. Dates are YYYY-MM-DD relative',
    'to today. JSON only.',
    ...(isDocument ? [
      '',
      'This is a document, not a deliberate update. Extract only durable team',
      'context — the decisions, rules, assumptions and reasons that outlive this file.',
      'Ignore document structure (headings, tables of contents, section order)',
      'and one-off details (a single meeting date, names mentioned in passing).',
      'If something is already in the context above, or listed as already',
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
