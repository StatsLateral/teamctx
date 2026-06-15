# teamctx

AI-native version control for team context. Every team member gets a continuously updated, role-specific context file for Claude, ChatGPT, or Gemini.

**No server. No seats. Bring your own API key.**

---

## How it works

1. Manager runs `teamctx init` in any git repo
2. Contribute updates: `teamctx contribute "..."` — AI updates the shared Why/What/How context and regenerates every role's context file
3. Role files auto-push to GitHub — accessible at a stable URL
4. Non-technical team members go to `/contribute` to submit updates and `/context/<role>` to download their file

---

## Quickstart

```bash
# Prerequisites: Node 18+, git, Anthropic API key in .env

npx teamctx init

# Add context
teamctx contribute "We are building a Q3 product launch targeting enterprise customers"

# Add roles (AI-assisted)
teamctx role add
# → prints: Context URL: yourproject.vercel.app/context/cpo

# Check status
teamctx status

# Keep context evolving
teamctx contribute "We decided to use AWS (Why). API migration starts next sprint (What)." --decision
```

---

## Commands

| Command | Description |
|---|---|
| `teamctx init` | Set up `.teamctx/` in the current git repo |
| `teamctx contribute "<text>"` | Add context — AI updates everything and pushes |
| `teamctx contribute "<text>" --decision` | Tag as a human decision (never pruned) |
| `teamctx contribute "<text>" --auto-approve` | Skip diff review |
| `teamctx role add` | Add a role interactively (AI-assisted) |
| `teamctx role add --suggest` | AI suggests roles from current context |
| `teamctx role list` | List all roles and their context URLs |
| `teamctx context <role>` | Print role MD to stdout |
| `teamctx pull` | Fetch and process web contributions |
| `teamctx reflect` | AI rewrites context for clarity (run weekly) |
| `teamctx status` | Project summary |

---

## Web layer (optional)

Deploy to Vercel to give non-technical team members:

- **`/context/<role>`** — downloads their role context file
- **`/contribute`** — a plain HTML form to submit updates

Manager runs `teamctx pull` to process web submissions.

Vercel env vars needed: `ANTHROPIC_API_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`

---

## File layout

```
.teamctx/
  config.json              # project name, roles, model, auto-push
  shared.json              # full Why/What/How tree (source of truth)
  context/
    shared.md              # human-readable, auto-regenerated
    roles/
      <slug>.md            # role-specific context file — this is what gets shared
  contributions.jsonl      # append-only audit log
```

---

## License

MIT
