# Roadmap

teamctx keeps your team's shared context in a simple why / what / how format to support "bring your own AI tool" for small teams.
It compiles a role-specific file for each person to bring to their AI tool without losing context.

**The vision** (the bets that guide this roadmap):

1. **No platform lock-in** — use any AI provider (Claude, OpenAI, Gemini, a local model). teamctx organizes context and answers `ask`, but you choose the engine.
2. **Bring your own tools & agents** — team members work in whatever AI tool they like, then feed distilled decisions back into the shared context.
3. **Managers stay in control** — they approve both the work and the shared context before it lands.
4. **Structured workstreams** — organize context into assignable workstreams — peers that each inherit the project's context — that can sync out to your project-management tools.
5. **Prove team productivity** — a team should be able to *see* that shared context is working: fewer redos, fresher context, faster first-pass acceptance — measured locally, no telemetry.

> ⚠️ **This roadmap is a set of suggestions, not commitments.** "Now" is roughly
> committed; "Next" is likely; "Later" is directional. Want to build one? Comment on
> its issue or open a [Discussion][d]. **Newcomers:** look for 🟢 (good first issue).
> Bigger items have a write-up in [`docs/proposals/`](docs/proposals/).

[d]: https://github.com/StatsLateral/teamctx/discussions

## Recently shipped 🎉

The previous roadmap is nearly all built (thank you, contributors!):

- **Provider-agnostic AI layer** — Claude, OpenAI, or Gemini behind one interface
- **MCP server, full surface** — every command callable from Claude Desktop/Code, Cursor, etc., with a tiered safety model and manager-identity gate
- **Manager approval queue** — contributions wait as durable pending objects; `review list/approve/reject`
- **Context snapshots** — freeze and approve known-good states of the whole workspace
- **AI-suggested workstream splits** — `workstream suggest` / `split` carve one Why/What/How tree into peer workstreams (not nested — workstreams are peers)
- **Tasks as first-class objects** — cheap local task CRUD + on-demand AI prompt compile per task
- **Bring-your-own-agent recipes** — copy-paste prompts for Claude Code, Cursor, ChatGPT
- **`ask` citations & audit** (#16) — every answer names the contributions it drew from; `ask --audit` expands the full source list
- **Hosted MCP with OAuth** (#17) — use teamctx from any MCP client with zero local install; operators deploy once via [docs/mcp-hosted-setup.md](docs/mcp-hosted-setup.md)
- **Context import (cold-start onboarding)** (#20) — `teamctx import <files…>` reads local docs a team already has and reverse-engineers a starting Why/What/How tree, proposed as pending contributions through the same manager-approval pipeline
- **`reflect` errors on unknown workstream ids** (#18) — rejects a typo'd workstream id instead of silently writing an empty stub
- **MCP test for `ask`'s `audit` param** (#19) — `mcp/server.test.js` covers the `audit` flag on the `ask` tool

## Now

The current focus is making teamctx **easy to start** and **able to prove it works** — the two things small pilot teams need most.

- **Local team-productivity metrics** — `teamctx stats`: contributions per week, approval latency, first-pass acceptance rate (approved vs. rejected/redone), role-file pulls, context freshness — all computed locally from the git history and audit log, nothing phones home — *prove team productivity* · [proposal](docs/proposals/local-metrics.md) · [#28](https://github.com/StatsLateral/teamctx/issues/28)
- **Project → workstream context inheritance, and the member's first-step brief** — make the hierarchy real: project context is one Why/What/How tree, and every workstream *inherits* the whole tree (a compile-time filter, not a copy) then adds its own branch — replacing today's partition model where `workstream split` just moves nodes out of `main`. On top of that: context can't be empty when a manager brings someone on, and a member's first action is a read-only brief — their assigned tasks plus their compiled project + workstream context. The membership model itself (task-list vs. named-role vs. workstream-position) is AI-proposed per project, not fixed. MVP collapses the team layer into the project; that layer stays a documented seam. **Land [#80](https://github.com/StatsLateral/teamctx/issues/80) first (the inherited project layer) — then [#81](https://github.com/StatsLateral/teamctx/issues/81) (AI-proposed structure), [#82](https://github.com/StatsLateral/teamctx/issues/82) (non-empty context gate), [#83](https://github.com/StatsLateral/teamctx/issues/83) (member brief) in any order, each a standalone PR**; [#84](https://github.com/StatsLateral/teamctx/issues/84) (docs) is independent — *structured workstreams · managers in control* · [design spec](docs/superpowers/specs/2026-09-09-context-inheritance-and-membered-onboarding-design.md)

## Next

- **First-run experience + `teamctx doctor`** — a new user should reach their first compiled role file in under 10 minutes. `doctor` checks the environment (git repo, Node version, API key present and valid, provider reachable) and prints one actionable fix per problem — *easy to start*
- **Mid-session decision capture** — the deeper promise: when a team member's AI tool reaches a decision mid-session, the tool itself proposes `submit_contribution` over MCP (with the member's confirmation), so decisions flow into shared context at the speed they're made instead of at the weekly review — *bring your own tools & agents* — builds on the recipes + MCP surface
- **Import connectors (6): Slack, Google Drive, Microsoft 365, Dropbox, Notion, Coda** — extend `teamctx import` beyond local files to where a team's context actually lives: a Slack channel or thread (where decisions get made and then die), a Google Drive folder, a SharePoint/OneDrive library (many SMB teams are Microsoft-cloud-first), a Dropbox folder, a Notion or Coda workspace. Thin, pull-based adapters with user OAuth — each connector feeds the same import → review-queue pipeline, no server required. One shared connector interface so each is a well-scoped, independent contribution: **build the contract first ([#21](https://github.com/StatsLateral/teamctx/issues/21)), then connectors in any order — each one is a great standalone PR**: [Slack #22](https://github.com/StatsLateral/teamctx/issues/22) · [Drive #23](https://github.com/StatsLateral/teamctx/issues/23) · [M365 #24](https://github.com/StatsLateral/teamctx/issues/24) · [Dropbox #25](https://github.com/StatsLateral/teamctx/issues/25) · [Notion #26](https://github.com/StatsLateral/teamctx/issues/26) · [Coda #27](https://github.com/StatsLateral/teamctx/issues/27) — *bring your own tools · easy to start* · [proposal](docs/proposals/context-import.md)
- **Workstream-scoped membership** — a manager invites someone into *one* workstream, and that person's AI sees, contributes to, and is compiled from only that workstream. Enforced server-side for members who reach the project through the hosted MCP (a no-GitHub member has no repo access of their own, so the server is their only path to the context); advisory for GitHub collaborators holding a clone, and documented as such rather than pretended otherwise. Revisits the "members are project-wide" decision in [project-members.md](docs/proposals/project-members.md) now that the hosted path makes enforcement real. Not RBAC or a permission matrix — one fact per member, which workstream(s) they are on; a member on no list stays project-wide, so existing projects change nothing — *managers in control · structured workstreams*
- **Manager handoff / co-manager** — the manager is pinned at `init` and, on purpose, unreachable afterwards (writing it is self-granting approval). Add a manager-gated way to name a co-manager, transfer the role, or step down — never leaving a project with zero managers. The API key does **not** transfer: the incoming manager brings their own key (or hosted lent-credential), so a client can run the project without depending on the builder's key. Unlocks the "here is the AI project — you can keep running it without me" handoff; the "stay on as fractional manager" half already works. Ships with a copy-paste recipe for packaging and handing off a project — *managers in control* · [#86](https://github.com/StatsLateral/teamctx/issues/86) · recipe [#87](https://github.com/StatsLateral/teamctx/issues/87)
- **Slack approval notifications** — when a contribution lands in the queue, ping the manager where they already live; approving stays in the CLI/MCP — *managers in control*
- **Context freshness signals** — role files and `status` surface "last approved N days ago / M pending contributions" so a stale context is visible before it misleads someone's AI — *prove team productivity*

## Later

- **More import connectors: Confluence, Airtable, Box…** — same connector interface; any popular document/knowledge tool is fair game once the contract exists — *bring your own tools*
- **Export workstreams to project-management tools** — push workstreams/tasks out to Jira, Linear, Asana, or Trello — *structured workstreams*
- **Non-git storage backends** — the GitHub-API adapter (#17) is the first step; a filesystem/DB backend would free teamctx from git entirely for non-technical teams
- **Cross-project context links** — a decision in one project's context updates a linked context in another (e.g. a product-strategy decision updates the GTM team's context)

## Non-goals (for now)

To keep the project focused while it's pre-product-market-fit:

- **No hosted SaaS UI** — the open-source core is the product until real teams demonstrably retain it. (A paid manager console may come later; the core stays free.)
- **No enterprise features** — SSO, RBAC, org hierarchies. Small teams first.
- **No single-vendor coupling** — nothing that only works with one AI provider's ecosystem. Cross-provider neutrality is the point.
