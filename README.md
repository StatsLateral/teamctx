# teamctx

**Your team uses AI. You still have to make the work fit together.**

You delegate a task. The draft comes back polished, but it:

- Sounds generic instead of speaking to your target customer.
- Revives an option you already rejected.
- Ignores a constraint you explained last week.

Now you’re repeating the background, correcting the assumptions and doing another review.

teamctx gives your team’s AI tools a shared, manager-approved understanding of the work: what you’re trying to achieve, what you’ve decided, which rules apply and what you’re still assuming.

**Make corrections reusable. Make approved decisions part of the daily context your team works from.**

Open source · Git-backed · Manager-approved · CLI + MCP · Bring your own API key

*AI-native version control for team context.*

**New:** run it entirely from your AI client via [MCP](#use-teamctx-from-your-ai-tool-mcp) — no terminal needed.

## When teamctx helps

- **You delegate work, then have to rebuild the context.** Give the next person—and their AI—the approved background relevant to their role.
- **The team agrees on a change, but old thinking keeps returning.** Update the shared decisions and constraints that collaborators retrieve.
- **AI-generated drafts look convincing but miss what matters.** Make the project’s goals, rationale and rules explicit before the next draft.
- **A teammate takes over your work.** Keep the project’s approved context available beyond your private AI conversations, so it doesn’t leave with the person who built it up.

## Where teamctx fits with your existing tools

You already have places to discuss work, write documents and track tasks. teamctx helps turn the decisions from that work into approved context your team’s AI tools can use.

| What you already use | What you use it for | Where teamctx helps |
|---|---|---|
| **Slack / Microsoft Teams** | Discuss options, share updates and coordinate | Capture the approved outcome so teammates don’t have to reconstruct it from a conversation. |
| **Notion / Google Docs / Confluence** | Develop plans, document knowledge and collaborate | Make the decisions, rules and assumptions relevant to a role explicit and available as an AI-ready brief. |
| **Jira / Asana / Monday.com** | Assign work and track delivery | Give the person doing the task—and their AI—the rationale and constraints behind it. |
| **Shared AI projects** | Work together using shared files, instructions and conversations inside an AI platform | Maintain a Git-backed record of approved project context that collaborators can use across supported AI tools. |
| **A manually maintained project brief** | Give collaborators a common starting point | Add proposed changes, manager review, version history and role-specific context as the work evolves. |

These tools have overlapping capabilities. teamctx brings a specific workflow: propose changes, review them and deliver approved context to collaborators using different AI tools.

Keep using the tools where your team already works. Bring relevant updates into teamctx through plain-language contributions, or import them from Slack, Notion, Google Drive, SharePoint and OneDrive, Dropbox and Coda. Other tools work through contributions: say what changed, and teamctx proposes the update.

## What this means for you as the team lead

### Delegate with the reasoning attached

Share the goal, relevant decisions and constraints alongside the task, so the next person has more than an assignment to work from.

### Make corrections reusable

When you clarify the target customer or reject an approach, make that clarification part of shared context for subsequent work.

### Keep changes deliberate

A suggestion from a teammate or AI can be reviewed before it becomes an approved decision, rule or exception.

### Bring people into the work without rebuilding every brief

Give a new teammate or contractor the approved context relevant to their role. Support handoffs and continued collaboration as responsibilities change.

### Let collaborators use their preferred AI tools

Use MCP where supported, or take generated briefs into other assistants. The shared project context stays in your Git repository.

## You decide what becomes shared context

People and AI tools contribute updates in plain language, and teamctx proposes the changes for review.

Approved context is organized by project, workstream and role, so collaborators can retrieve the parts relevant to their work. Git preserves the history, and approved snapshots provide explicit checkpoints.

## The model

```
Project
├─ goal (one line) + why it matters
├─ Workstream 1                 parts of the work, nested to any depth (1, 1.2, …);
│   ├─ Workstream 1.2           someone on a workstream reaches everything below it
│   │   └─ Task 1.2.1           tasks have an owner and are open or done
│   └─ Task 1.1
└─ Records, attached to the project, a workstream or a task
```

| Record | Read as | Governed by |
|---|---|---|
| decision | "We decided: … — why: …" | **always the manager** |
| rule | "Rule: …" | **always the manager** |
| exception | "Allowed: … (until <date>, instead of: <rule>)" — always shown under the rule it bends | **always the manager**; ends on its date |
| assumption | "We're assuming: … (check by <date>)" — has an owner | review policy |

The goal carries its own "why it matters", and the reason behind any record is
written with it.

Nobody picks a type: the AI classifies what people say, and the manager can
correct it during review. Every person's AI — Claude, ChatGPT, Gemini or an
agent — gets the same approved records for its part of the work, with each
exception printed under its rule. New projects review every contribution; the
manager's opening message is the one that lands on its own.


## How it works

1. **Define or refine the project.** Capture your existing goals, workstreams and roles with AI assistance.
2. **Contribute what changed.** Submit an update through the CLI or a supported MCP-connected AI tool.
3. **Review the proposed changes.** Approve or reject them before they enter shared team context.
4. **Continue the work.** Retrieve approved context through MCP or use generated role-specific briefs and task prompts.

Project state and history live in your Git repository, under your repository’s access controls. Optional web hosting has separate access settings.

### Example: a launch decision changes

Your team decides to sell to agencies instead of individual freelancers.

The product brief, campaign draft and sales narrative all need that decision. Updating one AI conversation leaves the other collaborators to catch up separately.

With teamctx, you contribute the change, review the proposed update and approve it. Collaborators can then retrieve the revised context before continuing their work.

An existing AI conversation still needs to fetch or receive that update. teamctx makes the approved change available; it does not silently rewrite every conversation.

## Built for small teams doing knowledge work

For product, GTM, marketing and operations teams where people already use AI—and a lead or manager is responsible for the combined result.

teamctx is particularly useful when you:

- Delegate work across people using different AI tools.
- Bring in contractors alongside your internal teammates.
- Hand work over when someone changes role or leaves.
- Need shared decisions and constraints to remain available as people join, leave or change responsibilities.

## Work through your existing AI tools

MCP-compatible clients can read context and submit contributions directly through teamctx. Generated Markdown or plain-text briefs can be used in other AI assistants.

teamctx’s own AI processing supports Anthropic, OpenAI and Gemini using your API key. Connection methods vary by client; see the integration guides for supported configurations.

The CLI and local MCP server run on your machine. Optional web deployment provides additional ways for teammates to access and contribute context.

## What teamctx does—and what it doesn’t

teamctx manages the shared team context you provide to AI tools. It makes approved decisions, constraints and assumptions available for the work.

It does not guarantee correct outputs, force an assistant to follow every instruction or automatically keep every open conversation current. Your team still exercises judgment and reviews the resulting work.

---

## Quickstart

```bash
# Prerequisites: Node 18+, git, and an Anthropic, OpenAI, or Gemini API key in .env.local

npx teamctx init

# Check the setup: each problem with how to fix it
teamctx doctor

# Add context
teamctx contribute "We are building a Q3 product launch targeting enterprise customers"

# Add roles (AI-assisted)
teamctx role add
# → prints: Context URL: yourproject.vercel.app/context/cpo

# Check status
teamctx status

# Keep context evolving
teamctx contribute "We decided to use AWS. We are assuming the migration fits in one sprint — check by Friday."
```

---

## Commands

| Command | Description |
|---|---|
| `teamctx init` | Set up `.teamctx/` in the current git repo |
| `teamctx doctor [--offline]` | Check the setup (git, project, Node, AI key, manager gate, remote) and say how to fix each problem; exits 1 if any failed. `--offline` skips the key check with the provider |
| `teamctx contribute "<text>"` | Add context — AI proposes changes and enqueues for manager approval |
| `teamctx contribute "<text>" --decision` | Tag as a human decision (never pruned) |
| `teamctx contribute "<text>" --auto-approve` | Skip the y/n confirmation on the proposed diff |
| `teamctx contribute "<text>" --apply` | Apply immediately instead of enqueueing (solo mode) |
| `teamctx role add` | Add a role interactively (AI-assisted) |
| `teamctx role add --suggest` | AI suggests roles from current context |
| `teamctx role list` | List all roles and their context URLs |
| `teamctx context <role>` | Print role MD to stdout |
| `teamctx ask "<question>" [--role <slug>] [--audit]` | Ask a question, answered from your team context. `--audit` appends a per-contribution source list |
| `teamctx pull` | Fetch and process web contributions |
| `teamctx review list` | List pending contributions awaiting manager approval |
| `teamctx review approve <id>` | Approve a pending contribution — applies to shared context |
| `teamctx review reject <id> [--reason "..."]` | Reject a pending contribution — archives with optional reason |
| `teamctx snapshot create [-m "..."]` | Freeze the current shared context as a pending snapshot |
| `teamctx snapshot list` | List all snapshots (marks the current-approved one) |
| `teamctx snapshot show <id>` | Print the snapshotted context to stdout (accepts a unique prefix) |
| `teamctx snapshot approve <id>` | Approve a pending snapshot — sets it as the current-approved state |
| `teamctx snapshot reject <id> [--reason "..."]` | Reject a pending snapshot |
| `teamctx snapshot current` | Show the current-approved snapshot |
| `teamctx config manager` | Show who may approve or reject |
| `teamctx manager list` | The primary manager and co-managers |
| `teamctx manager add <email>` / `remove <email>` | Add or remove a co-manager (manager only) |
| `teamctx manager transfer <email> [--step-down]` | Hand the primary manager role over (primary only) |
| `teamctx config provider <anthropic\|openai\|gemini>` | Pick which LLM provider teamctx calls |
| `teamctx config model <id>` | Pick a model from the selected provider's list |
| `teamctx status` | Project summary |
| `teamctx stats [--since <date>] [--workstream <id>] [--waits] [--json]` | Team metrics from your own history — no AI call, nothing leaves the machine |
| `teamctx mcp` | Start an MCP server over stdio so AI clients can call teamctx tools |
| `teamctx connect` | Print the URL a team member pastes into their AI client |
| `teamctx workstream add <name> [--under <id>]` | Add a part of the work, optionally under another (manager only) |
| `teamctx workstream list` | List all workstreams and their assigned roles |
| `teamctx workstream use <id>` | Set the active workstream |
| `teamctx role assign <slug> --workstream <id>` | Move a role to a workstream |
| `teamctx task add "<title>" [--owner ...] [--workstream ...]` | Track a task in the active workstream |
| `teamctx task list [--mine] [--status ...] [--all]` | List tasks (defaults to open in active workstream) |
| `teamctx task show <id>` | Show a task by id or unique prefix |
| `teamctx task done <id>` / `reopen <id>` | Toggle task status |
| `teamctx task assign <id> --owner <name>` | Reassign a task |
| `teamctx task rm <id>` | Remove a task (and its compiled prompt file, if any) |
| `teamctx task compile <id> [--role <slug>] [--force]` | AI-compile a focused prompt file for the task |

See [docs/providers.md](docs/providers.md) for the full provider guide.
See [docs/workstreams.md](docs/workstreams.md) for the full sub-workstreams guide.
See [docs/tasks.md](docs/tasks.md) for the full tasks guide.
See [docs/audit.md](docs/audit.md) for how `ask --audit` and the Contributors section work.
See [docs/import-dropbox.md](docs/import-dropbox.md) for importing documents from Dropbox.
See [docs/import-gdrive.md](docs/import-gdrive.md) for importing documents from Google Drive.
See [docs/import-m365.md](docs/import-m365.md) for importing documents from Microsoft 365.

---

## Use teamctx from your AI tool (MCP)

teamctx ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so any MCP-aware AI client can read your team's shared context and
write new contributions as native tools — no more copy-pasting between a
terminal and your AI.

The client uses whatever chat model you already run there; teamctx uses its
own API key for the tools it exposes. The MCP surface covers the full CLI:
reads (`get_context`, `get_role_context`, `list_workstreams`,
`get_workstream`, `list_roles`, `list_snapshots`, `get_status`, `get_config`,
`list_pending_reviews`, `list_records`, `get_record`, `suggest_roles`, `ask`);
writes (`contribute` with optional immediate-apply); and manager operations
gated by identity (`init`, `role_add`, `role_assign`, `workstream_add`,
`workstream_use`, `review_approve`, `review_reject`, `snapshot_create`,
`snapshot_approve`, `snapshot_reject`, `config_set`).

**Manager-focused walkthrough:** if you want to run teamctx entirely from
your AI client without touching a terminal, see
[docs/mcp-manager-guide.md](docs/mcp-manager-guide.md). Full technical
reference for every tool: [docs/mcp.md](docs/mcp.md).

### Prerequisites

- Node 18+ and `teamctx` on your PATH (`npm i -g teamctx`).
- A teamctx project on disk (run `teamctx init` in a git repo first).
- An Anthropic API key at [console.anthropic.com](https://console.anthropic.com)
  — either exported in your shell, in `.env.local` next to your project,
  or in the `env` block of your MCP config (shown below).

### Configuring your client

Every MCP client uses the same JSON block, only the file location differs.
teamctx resolves *which* project to use in this order:

1. `--project <path>` argument on the command
2. `TEAMCTX_PROJECT_DIR` environment variable
3. The working directory the client spawned the server from (unreliable on
   Windows — prefer #1 or #2)

**The paste-in block** (adjust the path to your project):

```json
{
  "mcpServers": {
    "teamctx": {
      "command": "teamctx",
      "args": ["mcp", "--project", "C:\\path\\to\\your\\teamctx\\project"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

> On Windows, use double backslashes in JSON paths. On macOS/Linux, forward
> slashes are fine.

#### Claude Desktop

1. Open Claude Desktop.
2. Click the Claude icon in the system tray (bottom-right on Windows) →
   **Settings** → **Developer** → **Edit Config**. This creates and opens
   `claude_desktop_config.json` in the right location, regardless of
   which install you have.
3. Merge the paste-in block above into the file. If `mcpServers` isn't
   there yet, add it as a new top-level key alongside anything else in
   the file — don't replace the file.
4. Fully quit Claude Desktop (system tray → Quit) and reopen it.
5. Verify: click the tools/hammer icon near the chat input — you should
   see the `teamctx` tools listed (the full surface is ~30 tools). Then
   prompt "Use the teamctx get_context tool to summarize my project."

#### Claude Code

Replace the two placeholders with your project path (**forward slashes
even on Windows** — claude's JSON validator rejects backslashes) and
API key.

macOS / Linux:

```bash
claude mcp add-json teamctx --scope user \
  '{"command":"teamctx","args":["mcp","--project","/path/to/your/project"],"env":{"ANTHROPIC_API_KEY":"sk-ant-..."}}'
```

Windows PowerShell (double quotes need `\"`):

```powershell
claude mcp add-json teamctx --scope user `
  '{\"command\":\"teamctx\",\"args\":[\"mcp\",\"--project\",\"D:/path/to/your/project\"],\"env\":{\"ANTHROPIC_API_KEY\":\"sk-ant-...\"}}'
```

`--scope user` makes it available from every `claude` session regardless
of the launch directory. Verify with `claude mcp list` — you should see
`teamctx: ... ✔ Connected`.

#### Cursor / Cline / Antigravity / other MCP clients

Same JSON shape. Add the paste-in block under whichever setting the
client uses for MCP servers (usually a settings pane or a config file
labeled "MCP" or "External tools"). Restart the client.

### Multiple projects

Register one entry per project with a distinct server name so the AI
sees them as separate tool groups:

```json
{
  "mcpServers": {
    "teamctx-webapp":  { "command": "teamctx", "args": ["mcp", "--project", "C:\\work\\webapp"],  "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } },
    "teamctx-mobile":  { "command": "teamctx", "args": ["mcp", "--project", "C:\\work\\mobile"],  "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } }
  }
}
```

### Troubleshooting

- **"Not in a teamctx project"** when calling a tool → the `--project`
  path is wrong or `.teamctx/` doesn't exist there. Run `teamctx status`
  in that folder to confirm.
- **Tools don't appear in the client** → check the client's MCP log (in
  Claude Desktop: `%APPDATA%\Claude\logs\mcp-server-teamctx.log`). The
  most common causes are `teamctx` not on PATH and JSON syntax errors.
- **`submit_contribution` fails with an API error** → the Anthropic key
  isn't reaching the server process. Move it into the `env` block of
  the MCP config rather than relying on shell exports.

See [`docs/mcp.md`](docs/mcp.md) for the full reference.

---

## Recipes: bring your own agent

Copy-paste prompts you can feed into Claude Code, Cursor, or ChatGPT to help
you author well-shaped contributions and clean up the shared context. See
[`recipes/`](recipes/README.md) for the recipe pack and per-tool guides.

---

## Self-hosting (web layer)

Deploy to Vercel to give non-technical team members two routes:

- **`/context/<role>`** — downloads their role context file
- **`/contribute`** — a plain HTML form to submit updates
- **`/ask`** — a plain HTML form to ask a question, answered from the shared (and optional role) context

Manager runs `teamctx pull` to process web submissions.

### Setup

**Prerequisites:** Node 18+, git, [Vercel CLI](https://vercel.com/docs/cli), Anthropic API key, GitHub account.

**1. Create a private GitHub repo**

Go to [github.com/new](https://github.com/new) and create a new **private** repository (e.g. `team-context`). Leave "Add a README" and "Add .gitignore" unchecked — the repo must be empty.

Then clone teamctx and point it at your new private repo:

```bash
git clone https://github.com/StatsLateral/teamctx team-context
cd team-context
git remote set-url origin https://github.com/YOUR_USERNAME/team-context
git push -u origin main
```

Replace `YOUR_USERNAME/team-context` with your actual GitHub username and repo name.

**2. Install and configure locally**

```bash
npm install
npm install -g .          # makes `teamctx` available in your shell
```

Add your Anthropic API key ([get one here](https://console.anthropic.com)) by running this in your terminal — replace the placeholder with your real key:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-your-key-here" > .env.local
```

This file is gitignored and stays on your machine only.

**3. Initialize teamctx**

```bash
teamctx init
# Prompts: project name, your name, model, auto-push, Vercel URL (leave blank for now)
```

This creates `.teamctx/` and commits it to your private repo.

**4. Deploy to Vercel**

Connect your private repo to a new Vercel project:

```bash
vercel link      # follow prompts — create a new project linked to your private repo
```

Set the required env var:

```bash
vercel env add ANTHROPIC_API_KEY production
```

Deploy:

```bash
vercel --prod
```

Copy the production URL (e.g. `https://team-context-xyz.vercel.app`).

**5. Update your config with the deploy URL**

```bash
teamctx config deploy-url https://team-context-xyz.vercel.app
```

**6. Enable web contributions** (optional — only needed for `/contribute` and `teamctx pull`)

The contribution form writes directly to your private GitHub repo. Add two env vars to your Vercel project:

```bash
vercel env add GITHUB_TOKEN production   # fine-grained PAT, Contents: read+write on your private repo
vercel env add GITHUB_REPO production    # e.g. StatsLateral/myaccount
```

Then pull them to your local `.env.local` so `teamctx pull` can read them:

```bash
vercel env pull .env.local
```

### Keeping context current

Every `teamctx contribute` commits and pushes to your private repo. Vercel's git integration auto-deploys on push — role files at `/context/<role>` are always up to date within seconds.

### Slack notices

A manager can have a Slack channel told whenever something is waiting for their approval. Each message holds the item's number, who sent it, a one-line summary and a link to it. The text of what was sent is never included. On the hosted server, set the channel's [incoming webhook](https://api.slack.com/messaging/webhooks) in **Settings → Slack**. On the command line, put it in `.env.local` as `TEAMCTX_SLACK_WEBHOOK`. It is read on the machine that sends the item, so it only covers people who have it set; members who work through the hosted server are covered by the Settings one. A command-line notice goes out once the item is pushed, since the link opens the hosted page. An import sends one notice for the whole run. The webhook is never written to the repository. If a post fails, it is logged and skipped, and the contribution is never held up.

### Security model

- **Source + data** (`.teamctx/`) live in your private GitHub repo — only visible to you
- **Role files** are served publicly at `/context/<role>` — share URLs directly with teammates
- `contributions.jsonl` and `config.json` are never served; they stay on the Vercel filesystem only
- The `/contribute` form is public (no login required) — manager reviews and approves all submissions via `teamctx pull` before anything is committed
- The `/ask` form is public too (no login required) — it only reads context to answer questions, it never writes to your repo

---

## File layout

```
.teamctx/
  config.json                       # project name, roles, model, auto-push, manager
  project.json                      # the goal, project-level records and tasks (source of truth)
  workstreams/
    <id>.json                       # one per workstream: its records and tasks (nesting lives in config.json)
  context/
    workstreams/
      <id>.md                       # human-readable brief per workstream, project context above it
    roles/
      <slug>.md                     # role-specific context file — this is what gets shared
  contributions.jsonl               # append-only audit log
  queue/                            # pending contributions awaiting manager approval
  rejected/                         # archived rejected contributions (with reason)
  snapshots/                        # versioned context checkpoints; current.json points to the last approved
  pending/                          # raw web submissions inbox (processed by `teamctx pull`)
```

---

## License

MIT

## Project

- [Installation and quickstart](#quickstart)
- [MCP manager guide](docs/mcp-manager-guide.md)
- [MCP technical reference](docs/mcp.md)
- [AI provider configuration](docs/providers.md)
- [Workstreams](docs/workstreams.md)
- [Tasks](docs/tasks.md)
- [Roadmap](ROADMAP.md) — where teamctx is going
- [Contributing](CONTRIBUTING.md) — how to propose changes (DCO sign-off required)
- [Changelog](CHANGELOG.md) — what changed, per release
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)

Licensed under the [MIT License](LICENSE).
