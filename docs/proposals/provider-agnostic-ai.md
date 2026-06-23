# Proposal: Provider-agnostic AI layer

**Status:** Proposal (suggestion, not committed) · **Serves:** No platform lock-in ·
**Rough size:** Medium · good for someone comfortable with a small refactor

## Problem

teamctx calls an LLM to distill contributions into the why/what/how tree, to
regenerate role files, and to answer `ask`. Today every one of those calls goes
through Claude specifically. That ties the whole project to one vendor — the
opposite of the "no platform lock-in" vision. A team should be able to point
teamctx at OpenAI, a local model, or whatever they already pay for.

## What exists today

- `src/ai.js` exports `callClaude(...)`, which constructs an `Anthropic` client
  from `@anthropic-ai/sdk` and reads `ANTHROPIC_API_KEY`.
- Callers: `src/context.js` (`proposeDiff`, `generateRoleFile`), the `reflect`
  flow, and `api/ask.js`.
- Model selection already exists: `teamctx config model <value>` stores a model
  string in `.teamctx/config.json` (default `claude-haiku-4-5`).

## Suggested approach (one way to do it)

1. **Define a tiny provider interface** — a single function shape, e.g.
   `complete({ system, messages, model }) -> { text }`. Keep it minimal; this is
   not an attempt to wrap every provider feature.
2. **Move the current Claude code behind an `anthropic` provider** that implements
   that interface. `callClaude` becomes `AnthropicProvider.complete`.
3. **Add a second provider** (e.g. `openai`) implementing the same interface, to
   prove the abstraction holds. This is a natural 🟢 good-first-issue *after* the
   interface lands.
4. **Select the provider from config** — add `teamctx config provider <name>`
   alongside the existing `model` setting; each provider reads its own key from
   env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), keeping bring-your-own-key.
5. **Route all existing call sites** through the selected provider instead of
   `callClaude` directly.

## Scope

**In:** the interface, the Anthropic provider, one additional provider, config
selection, updating call sites, tests for the selection logic (mock providers).

**Out (for this proposal):** streaming, tool-calling, per-call provider overrides,
local-model runners. Note them as follow-ups, don't build them here (YAGNI).

## Where to start

- Read `src/ai.js` and `src/ai.test.js` to see how `callClaude` is shaped and tested.
- Land the interface + Anthropic provider with the existing tests still green
  (pure refactor, no behavior change). That's a complete, reviewable first PR.

## Open questions

- One provider per project, or per-call selection? (Suggested: per-project first.)
- How should a provider declare which model names it accepts?
