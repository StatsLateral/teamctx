# Roadmap

teamctx keeps your team's shared context in a simple why / what / how format to support "bring your own AI tool" for small teams.
It compiles a role-specific file for each person to bring to their AI tool without losing context.

**The vision** (the bets that guide this roadmap):

1. **No platform lock-in** — use any AI provider (Claude, OpenAI, Gemini, a local model). teamctx organizes context and answers `ask`, but you choose the engine.
2. **Bring your own tools & agents** — team members work in whatever AI tool they like, then feed distilled decisions back into the shared context.
3. **Managers stay in control** — they approve both the work and the shared context before it lands.
4. **Structured workstreams** — organize context into assignable, nestable workstreams that can sync out to your project-management tools.
5. **Prove team productivity** — a team should be able to *see* that shared context is working: fewer redos, fresher context, faster first-pass acceptance — measured locally, no telemetry.

> ⚠️ **This roadmap is a set of suggestions, not commitments.** "Now" is roughly
> committed; "Next" is likely; "Later" is directional. Want to build one? Comment on
> its issue or open a [Discussion][d]. **Newcomers:** look for 🟢 (good first issue).
> Bigger items have a write-up in [`docs/proposals/`](docs/proposals/).

[d]: https://github.com/statslateralinc/teamctx/discussions

## Recently shipped 🎉

The previous roadmap is nearly all built (thank you, contributors!):

- **Provider-agnostic AI layer** — Claude, OpenAI, or Gemini behind one interface
- **MCP server, full surface** — every command callable from Claude Desktop/Code, Cursor, etc., with a tiered safety model and manager-identity gate
- **Manager approval queue** — contributions wait as durable pending objects; `review list/approve/reject`
- **Context snapshots** — freeze and approve known-good states of the whole workspace
- **AI-suggested sub-workstreams** — `workstream suggest` / `split`, nested workstreams
- **Tasks as first-class objects** — cheap local task CRUD + on-demand AI prompt compile per task
- **Bring-your-own-agent recipes** — copy-paste prompts for Claude Code, Cursor, ChatGPT

In review: **`ask` citations & audit** (#16 — every answer names the contributions it drew from) and **hosted MCP with OAuth** (#17 — use teamctx from any MCP client with zero local install).

## Now

The current focus is making teamctx **easy to start** and **able to prove it works** — the two things small pilot teams need most.

- **Context import (cold-start onboarding)** — `teamctx import <files…>`: point it at the artifacts a team already has (decks, docs, meeting notes) and the AI reverse-engineers a starting Why/What/How tree, proposed as pending contributions for the manager to review. Today a new team starts from a blank tree, which is the single biggest adoption cliff — *bring your own tools · managers in control* · [proposal](docs/proposals/context-import.md)
- **Local team-productivity metrics** — `teamctx stats`: contributions per week, approval latency, first-pass acceptance rate (approved vs. rejected/redone), role-file pulls, context freshness — all computed locally from the git history and audit log, nothing phones home — *prove team productivity* · [proposal](docs/proposals/local-metrics.md)
- 🟢 **`reflect` should error on unknown workstreams** — `reflectCore` has an unreachable guard: `readWorkstream` never returns falsy, so reflecting a typo'd workstream id silently writes an empty stub instead of failing. Make it a real error with a test.
- 🟢 **MCP test for `ask`'s `audit` param** — once #16 lands, `mcp/server.test.js` should cover the `audit` flag on the `ask` tool.

## Next

- **First-run experience + `teamctx doctor`** — a new user should reach their first compiled role file in under 10 minutes. `doctor` checks the environment (git repo, Node version, API key present and valid, provider reachable) and prints one actionable fix per problem — *easy to start*
- **Mid-session decision capture** — the deeper promise: when a team member's AI tool reaches a decision mid-session, the tool itself proposes `submit_contribution` over MCP (with the member's confirmation), so decisions flow into shared context at the speed they're made instead of at the weekly review — *bring your own tools & agents* — builds on the recipes + MCP surface
- **Context freshness signals** — role files and `status` surface "last approved N days ago / M pending contributions" so a stale context is visible before it misleads someone's AI — *prove team productivity*
- **OAuth hardening for hosted MCP** (after #17 lands) — validate `redirect_uri` at token exchange against the `/authorize` value; make one-shot code consumption atomic (`GETDEL`) — well-scoped, security-minded contributors welcome
- **Self-host guide** — deploy the hosted MCP + web surface on your own Vercel account end to end

## Later

- **Export workstreams to project-management tools** — push workstreams/tasks out to Jira, Linear, Asana, or Trello — *structured workstreams*
- **Non-git storage backends** — the GitHub-API adapter (#17) is the first step; a filesystem/DB backend would free teamctx from git entirely for non-technical teams
- **Cross-project context links** — a decision in one project's context updates a linked context in another (e.g. a product-strategy decision updates the GTM team's context)

## Non-goals (for now)

To keep the project focused while it's pre-product-market-fit:

- **No hosted SaaS UI** — the open-source core is the product until real teams demonstrably retain it. (A paid manager console may come later; the core stays free.)
- **No enterprise features** — SSO, RBAC, org hierarchies. Small teams first.
- **No single-vendor coupling** — nothing that only works with one AI provider's ecosystem. Cross-provider neutrality is the point.
