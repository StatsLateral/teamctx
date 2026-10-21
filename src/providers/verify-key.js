/**
 * Whether an AI key works, shared by the Settings page, the manager checks and
 * `teamctx doctor`.
 */

const LIST_MODELS = {
  anthropic: key => ['https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }],
  openai: key => ['https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } }],
  // The key rides in a header, not the query string, so it never lands in a log.
  gemini: key => ['https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': key } }],
};

/**
 * Does this key work? Asked of the provider's list-models endpoint.
 *
 * It spends nothing: listing models needs a valid key and generates no tokens.
 * A rejected key and an unreachable provider are told apart, because calling a
 * working key broken over a network blip would refuse a promotion for nothing.
 */
export async function verifyProviderKey({ provider = 'anthropic', apiKey } = {}, fetchImpl = globalThis.fetch) {
  const build = LIST_MODELS[provider];
  if (!build) return { ok: false, why: `Unknown provider "${provider}", so the key could not be checked.` };
  if (!apiKey) return { ok: false, why: 'There is no key to check.' };
  let res;
  try {
    const [url, init] = build(apiKey);
    res = await fetchImpl(url, { method: 'GET', ...init });
  } catch {
    return { ok: false, transient: true, why: `Could not reach ${provider} to check the key just now. Try again in a minute.` };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403 || res.status === 400) {
    return { ok: false, why: `${provider} rejected the key (${res.status}).` };
  }
  return { ok: false, transient: true, why: `${provider} answered ${res.status} when checking the key. Try again in a minute.` };
}
