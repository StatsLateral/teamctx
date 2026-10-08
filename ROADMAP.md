# Roadmap

teamctx keeps the decisions, assumptions, rules and exceptions your team's AIs must follow — approved by the manager, wherever each person's AI runs — for small teams.
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

The web page and the assistant-first flow (October 2026):

- **The project page** — a read-only page for a manager or a member: the goal and why it matters, the work as a tree, tasks, and what is waiting on the manager, with drawers for the project's and each workstream's context (#138–#141, #156)
- **Decide in your assistant first** — a queued contribution is read back in the person's own chat, with its tasks as a separate decision (`review_approve` takes `tasks: include | leave_out`); the page opens the assistant with the right prompt and stays read-only (#154, #158, #142)
- **Task history** — who asked for a task, who approved it, and when it was done (#143)
- **My Team** — members, agents and external talent in one drawer; a manager can list someone as external (#162)
- **Connectors that recover** — opening a connector address in a browser says what it is (#164); a connector whose GitHub sign-in was revoked signs in again by itself (#166)

Earlier:

- **Governed records** (#117) — the goal, nested workstreams, tasks, and four kinds of governed record: decisions, assumptions, rules and exceptions (each exception shown under the rule it bends, with an end date)
- **When an assumption breaks, show what rests on it, and the checks around it** — impact (#120), new evidence proposed as "assumption at risk" (#122), the contradiction check (#121), and one review-and-impact screen (#118)
- **Project → workstream inheritance and the member's first-step brief** (#80–#83, #85, #90); **workstream-scoped membership**, enforced server-side for members who reach the project through the hosted MCP
- **Manager handoff and co-managers** (#86, #87) and **tokens for unattended agents**
- **Context import and its six connectors** — `teamctx import` reads local files, Slack, Google Drive, Microsoft 365, Dropbox, Notion and Coda, and proposes what it finds through the review queue (#20–#27)
- **Local team-productivity metrics** — `teamctx stats` (#28)
- **Hosted MCP with OAuth** (#17), the **manager approval queue**, **context snapshots**, **tasks as first-class objects**, the **provider-agnostic AI layer**, **`ask` citations & audit** (#16), and **bring-your-own-agent recipes**

## Now

- **Task submissions in the review queue, and AI-suggested next steps** — a draft sent back for a task is shown against that task, approving it marks the task done, and the approver decides which follow-on tasks to add — *managers in control* · [#144](https://github.com/StatsLateral/teamctx/issues/144)
- **Tasks the AI proposes read as work a person would pick up** — today they can read as steps for an assistant — *managers in control* · [#175](https://github.com/StatsLateral/teamctx/issues/175)

## Next

- **Connected sources** — record what a project draws on (which tool, which item, when it was read, which tasks it feeds), as links and summaries and never copies of files, in the team's own repository; the drawer in Settings shows sample data until then. One issue each for **Slack, Notion, Google Drive, Microsoft SharePoint, Dropbox and Coda**; build the record first, then connectors in any order — each is a good standalone PR. The open-source options (Activepieces and Onyx cover all six, both MIT) are surveyed in the first issue — *bring your own tools* · [#168](https://github.com/StatsLateral/teamctx/issues/168) · [Slack #169](https://github.com/StatsLateral/teamctx/issues/169) · [Notion #170](https://github.com/StatsLateral/teamctx/issues/170) · [Drive #171](https://github.com/StatsLateral/teamctx/issues/171) · [SharePoint #172](https://github.com/StatsLateral/teamctx/issues/172) · [Dropbox #173](https://github.com/StatsLateral/teamctx/issues/173) · [Coda #174](https://github.com/StatsLateral/teamctx/issues/174)

These have no open issue yet; open one, or comment in a [Discussion][d], if you want to build one:

- **First-run experience + `teamctx doctor`** — a new user should reach their first compiled role file in under 10 minutes. `doctor` checks the environment (git repo, Node version, API key present and valid, provider reachable) and prints one actionable fix per problem — *easy to start*
- **Mid-session decision capture** — when a team member's AI tool reaches a decision mid-session, the tool itself proposes `submit_contribution` over MCP (with the member's confirmation), so decisions flow into shared context at the speed they're made instead of at the weekly review — *bring your own tools & agents*
- **Slack approval notifications** — when a contribution lands in the queue, ping the manager where they already live; approving stays in the assistant or the command line — *managers in control*
- **Context freshness signals** — role files and `status` surface "last approved N days ago / M pending contributions" so a stale context is visible before it misleads someone's AI — *prove team productivity*

## Parked

Open, and not being worked on until there is a reason:

- **Non-technical member's fallback path** still needs a terminal and git — [#93](https://github.com/StatsLateral/teamctx/issues/93)
- **A GitHub App instead of the OAuth `repo` scope**, to narrow access to the project's repository — [#110](https://github.com/StatsLateral/teamctx/issues/110)
- **A read log**, so a manager can see who read which part of the context — [#111](https://github.com/StatsLateral/teamctx/issues/111)
- **Approve and Reject buttons on the page itself.** Deciding stays in the assistant on purpose; this needs the server-side manager check, a confirmation, and a record before it is worth building — [#176](https://github.com/StatsLateral/teamctx/issues/176)

## Later

- **More import connectors: Confluence, Airtable, Box…** — same connector interface; any popular document/knowledge tool is fair game — *bring your own tools*
- **Export workstreams to project-management tools** — push workstreams/tasks out to Jira, Linear, Asana, or Trello — *structured workstreams*
- **Non-git storage backends** — the GitHub-API adapter (#17) is the first step; a filesystem/DB backend would free teamctx from git entirely for non-technical teams
- **Cross-project context links** — a decision in one project's context updates a linked context in another (e.g. a product-strategy decision updates the GTM team's context)
- **Team layer** — context shared by several projects, inherited above each project's own the way a workstream inherits its project. Deferred: today one team is one project — *structured workstreams* · [seam note](docs/proposals/team-layer.md)

## Non-goals (for now)

To keep the project focused while it's pre-product-market-fit:

- **No hosted SaaS UI** — the open-source core is the product until real teams demonstrably retain it. (A paid manager console may come later; the core stays free.)
- **No enterprise features** — SSO, RBAC, org hierarchies. Small teams first.
- **No single-vendor coupling** — nothing that only works with one AI provider's ecosystem. Cross-provider neutrality is the point.
