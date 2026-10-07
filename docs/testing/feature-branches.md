# Test #120 and #126 locally

Use PowerShell and **separate fresh sandbox directories**. Run the source CLI
directly so a globally installed `teamctx` cannot accidentally test old code.
These branches are separate: #126 does not include #120.

## Before each test

```powershell
$source = 'D:\work\teamctx'
$cli = Join-Path $source 'cli\index.js'
Set-Location $source
git status --short
```

Finish or save any tracked changes before switching. Leave existing sandbox
projects alone. Each sandbox name below must be new; choose another name if it
already exists. Set the provider key in this shell or the sandbox's `.env.local`.
For Anthropic:

```powershell
$env:ANTHROPIC_API_KEY = '<your key>'
```

During `init`, enter a project name, accept your Git identity, choose your
provider/model, answer **n** to auto-push, and leave deployment/raw URLs blank.
Use your usual Git name/email; configure them locally in the sandbox if needed.

## #120: broken-assumption impact

1. Select the implementation, run its tests, and initialize a fresh project:

   ```powershell
   Set-Location $source
   git switch feat/broken-assumption-impact
   npm.cmd test
   New-Item -ItemType Directory -Path 'D:\work\teamctx-smoke-120'
   Set-Location 'D:\work\teamctx-smoke-120'
   git init
   node $cli init
   ```

2. Create one assumption and two decisions resting on it:

   ```powershell
   node $cli contribute 'Our goal is an enterprise pilot. We assume enterprise buyers require SSO before agreeing to a pilot. The project manager owns this assumption and will review it on 2026-10-12. Based on that assumption, we decided to build SSO before reporting work and delay the Acme pilot until SSO ships.' --apply --auto-approve
   $tree = Get-Content -Raw .teamctx\project.json | ConvertFrom-Json
   $tree.records | Select-Object id,type,text,status,@{Name='restsOn';Expression={$_.links.restsOn -join ', '}} | Format-Table -Wrap
   ```

   Check that both decisions' `links.restsOn` contain the assumption's ID.
   AI extraction can vary: inspect this before continuing. Save these IDs:

   ```powershell
   $assumptionId = ($tree.records | Where-Object type -eq 'assumption' | Select-Object -First 1).id
   $decisionIds = @($tree.records | Where-Object type -eq 'decision' | Select-Object -ExpandProperty id)
   ```

3. Break the existing assumption, keeping both decisions active:

   ```powershell
   node $cli contribute 'We disproved the existing assumption that enterprise buyers require SSO before agreeing to a pilot. Acme will pilot without SSO. Mark that assumption broken. Keep both existing decisions active so they can be reviewed.' --apply --auto-approve
   node $cli brief
   $brokenTree = Get-Content -Raw .teamctx\project.json | ConvertFrom-Json
   $brokenTree.records | Select-Object id,text,status,brokenAt,reviewedAt | Format-Table -Wrap
   Select-String -Path .teamctx\project.json -Pattern 'needsReview'
   ```

   Expect both decisions to need review, a timestamp on the broken assumption,
   both decisions still active, and **no** persisted `needsReview` match.

4. Check the other read surfaces while the flag is still present. Connect your
   local MCP client to `node D:\work\teamctx\mcp\server.js`, with its working
   directory set to this sandbox and the provider key available. Ask it:

   > Use list_records, get_record for each affected decision, get_context, and
   > my_brief. Show whether each decision needs review. Do not mutate anything.

   Each should carry the review flag. Add and compile a task too:

   ```powershell
   node $cli task add 'Prepare enterprise pilot'
   $taskId = ((Get-Content -Raw .teamctx\project.json | ConvertFrom-Json).tasks | Select-Object -First 1).id
   node $cli task compile $taskId
   ```

   Open the printed prompt file: it should flag affected decisions. The flag's
   own label must not quote the broken assumption. If checking the web page,
   run/deploy **this branch** against a test repository containing this sandbox
   data; an existing production page cannot exercise unpushed code. Check the
   amber chips on both decisions. Without a test deployment, the route tests
   cover this read surface locally.

5. Reconfirm one decision without replacing it, then replace the other:

   ```powershell
   node $cli contribute 'Reconfirm the existing decision Build SSO before reporting work. We still choose it for security reasons. Set that same decision active and record this review; do not replace it or create another copy.' --apply --auto-approve
   node $cli contribute 'Replace the existing decision Delay the Acme pilot until SSO ships with Start the Acme pilot now without SSO.' --apply --auto-approve
   node $cli brief
   $after = Get-Content -Raw .teamctx\project.json | ConvertFrom-Json
   $after.records | Select-Object id,text,status,brokenAt,reviewedAt | Format-Table -Wrap
   ```

   Expect the reconfirmed decision to retain its original ID and gain
   `reviewedAt > brokenAt`, even on the same day. Its flag clears. The other
   original decision becomes replaced; its replacement is active. No affected
   active decision remains flagged. A reconfirmation producing `addRecord`
   instead of `setRecordStatus:active` is a failure.

## #138: numbers for workstreams and tasks, not for records

Replaces the stable letter keys (#126). Workstreams are numbered `1, 2, 3` across
the project, tasks are `workstream.task` (`3.2`), and records have no number.

1. Use a fresh sandbox:

   ```powershell
   Set-Location $source
   npm.cmd test
   New-Item -ItemType Directory -Path 'D:\work\teamctx-smoke-138'
   Set-Location 'D:\work\teamctx-smoke-138'
   git init
   node $cli init
   ```

2. A task needs a workstream, and workstreams are numbered flat:

   ```powershell
   node $cli task add 'Prepare pilot'
   node $cli workstream add 'Launch'
   node $cli workstream add 'Pricing' --under launch
   node $cli workstream add 'Support'
   node $cli workstream list
   ```

   The first `task add` must refuse: a task belongs to a workstream, and the
   message says to add one. `workstream list` shows `1 Launch`, `2 Pricing`
   indented under it, and `3 Support`: nesting is the indent, not the number.

3. Verify task numbers and deletion:

   ```powershell
   node $cli task add 'Prepare pilot' --workstream launch
   node $cli task add 'Contact Acme' --workstream launch
   node $cli task add 'Quote the tiers' --workstream pricing
   node $cli task rm 1.1
   node $cli task add 'Prepare reporting' --workstream launch
   node $cli task list --all
   ```

   Expect `1.1` and `1.2`, then `2.1` for Pricing, then `1.3`. Deleting `1.1`
   must not renumber `1.2` or reuse `1.1`. No `T-` key appears anywhere.

4. Verify waiting items are numbered at once and keep their number:

   ```powershell
   node $cli config review-policy all
   node $cli contribute 'Add a task to prepare the Acme pilot deck' --workstream launch --auto-approve
   node $cli review list
   ```

   Expect the item to be submitted as the next number in Launch (`1.4`). The
   number is printed with it. Approve it by number:

   ```powershell
   node $cli review approve 1.4
   node $cli task show 1.4
   ```

   The task it became keeps `1.4`. Repeat with another queued item and
   `review reject <number>`: its number is never reused. A queued edit to an
   existing task shows that task's number and spends none.

5. Verify records have no number and do not appear on the page:

   ```powershell
   node $cli contribute 'We decided to start the Acme pilot before SSO is ready.' --apply --auto-approve
   node $cli brief
   Get-Content -Raw .teamctx\project.json
   ```

   Expect the decision to have an internal `id` and no `key`, and the brief to
   print `We decided: ...` with no letter or number. In a test web deployment,
   the project page lists tasks and what is waiting, with no Context tab, no
   inherited table and no record rows; `?task=1.2` and `?review=1.4` mark the
   same rows as links using their internal ids.

Return the source checkout to the active next-issue branch when finished:

```powershell
Set-Location $source
git switch feat/unified-project-rows
```

## PR descriptions: what and why

**#120 — Flag decisions and rules resting on broken assumptions**

What: record explicit `restsOn` dependencies and derive review flags when an
assumption breaks. Carry flags through record reads, context, briefs, compiled
task prompts and the project page. Stamp `brokenAt` and `reviewedAt`; allow
reconfirmation of the existing record or replacement as the review exits.

Why: breaking an assumption must show which active choices need another look.
Date-only updates cannot distinguish a break from a reconfirmation later that
day. Deriving the flag preserves active records and avoids stale stored flags.

Linked issue: `Closes #120`. Base: `main`. Head:
`feat/broken-assumption-impact`. Validation: local suite plus the real-AI sandbox
checks above. Add the actual results before opening the PR.

**#126 — Add stable project-wide task and record keys**

What: persist `T-`, `D-`, `R-`, `A-` and `X-` keys, backfill existing records and
tasks on their first write, and show/resolve keys in tools, prompts and page
links. Allocate only for accepted writes; preserve counters across deletions,
review queues and concurrent writes.

Why: people need a handle that stays attached to the same item when surrounding
items change. Pending/rejected proposals must not consume numbers, and existing
projects need consistent keys without manual migration.

Linked issue: `Closes #126`. Base: `main`. Head: `feat/stable-record-keys`.
Validation: 2,108 tests passed on this branch when completed, including storage
and command integration tests; add your manual test results.

For each PR, use `.github/pull_request_template.md`: check tests, the Unreleased
CHANGELOG entry, DCO sign-offs and one logical change. These changes extend the
project's own governance model; they add no general-purpose plumbing or library.
