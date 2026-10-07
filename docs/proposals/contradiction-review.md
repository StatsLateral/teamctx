# Contradiction review

**Status:** Implemented · **Issue:** #121
**Base:** `feat/unified-project-rows` (includes #126 and #127; #120 remains separate).
Read issue #121 and the governed-records proposal before implementation.

## What and why

Check proposed record additions and edits against active decisions and rules in
the same part of the work and its ancestors. Conflicts belong in the review
queue, with both statements named. They cannot bypass review through `--apply`,
the founding path or the additive policy. An AI flag never approves a change.

Use the existing provider call in `proposeDiff`: return structured contradiction
references beside operations. Validate those references against the actual
comparison set; render stored record text, not model-invented labels. Compare
only the target, its ancestors and the project, never siblings or descendants.
Tasks and metadata-only record edits are not contradictions. Explicit allowed
exceptions to rules are not contradictory decisions.

The manager can reject, approve an already explicit `links.replaces`, or pass a
record ID/key to `review approve --replaces` / `review_approve`. This converts a
flagged addition or edit into a replacement, preserving the old record in
history. Multiple replacements may be specified; every remaining active
conflict must be resolved. An inherited record must be changed in its own part
of the work before the child proposal can be approved; a child cannot silently
override a project or ancestor decision.

Expose flags in contribution results, CLI review, MCP review and the page's
manager-only queue. Preserve flags in rejected items and approval results.
Queueing and failed approval do not allocate stable keys.

## Existing open source first

Reuse the project's AI providers, operations, record validation and review gate.
This is product governance; no additional SDK, search service or vector store is
needed. Semantic accuracy depends on the provider; fixtures verify unrelated
records are not flagged and the prompt explains actual contradiction criteria.

## Validation

- [x] Structured AI output, reference validation and dropped-operation mapping.
- [x] Scope: same part, project and visible inheritance, never siblings.
- [x] Conflicts queue under every policy and direct-apply request.
- [x] Replacement/rejection exits, edits, inherited conflicts and stable keys.
- [x] CLI, MCP and page output name both statements and escape stored text.
- [x] Full suite, CHANGELOG and signed-off commit.

Full suite: 124 test files and 2,155 tests passed.

Four real-provider sandbox cases passed: local conflict and replacement,
unrelated contribution, inherited conflict and refusal to replace it from a
child, and an allowed exception. The exception run exposed a provider false
positive; normalization now excludes the specific rule an exception validly
bends, with regression coverage for additions and edits.

If comparison records change during proposal generation, recheck the saved
operations against the fresh records. Refuse a write if that comparison changes
again. Missing or invalid contradiction output cannot silently bypass review.
