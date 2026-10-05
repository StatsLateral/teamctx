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

## #126: stable task and record keys

1. Switch source branches and use another fresh sandbox:

   ```powershell
   Set-Location $source
   git switch feat/stable-record-keys
   npm.cmd test
   New-Item -ItemType Directory -Path 'D:\work\teamctx-smoke-126'
   Set-Location 'D:\work\teamctx-smoke-126'
   git init
   node $cli init
   ```

2. Verify task numbering and deletion:

   ```powershell
   node $cli task add 'Prepare pilot'
   node $cli task add 'Contact Acme'
   node $cli task rm T-1
   node $cli task add 'Prepare reporting'
   node $cli task list --all
   ```

   Expect `T-1`, `T-2`, then `T-3`. Deleting `T-1` must not renumber `T-2` or
   reuse `T-1`.

3. Verify record keys and delayed allocation for manager review:

   ```powershell
   node $cli contribute 'Our goal is the Acme pilot. We decided to start the Acme pilot before SSO is ready.' --apply --auto-approve
   node $cli config review-policy all
   $beforeQueue = (Get-Content -Raw .teamctx\config.json | ConvertFrom-Json).nextKey | ConvertTo-Json -Compress
   node $cli contribute 'We decided the pilot will last exactly two weeks.' --auto-approve
   node $cli review list
   $afterQueue = (Get-Content -Raw .teamctx\config.json | ConvertFrom-Json).nextKey | ConvertTo-Json -Compress
   $beforeQueue -eq $afterQueue
   ```

   Expect the first decision to be `D-1`. The queued proposal has no assigned
   key, and the counter comparison is `True`. Approve the ID printed by review:

   ```powershell
   node $cli review approve '<QUEUE-ID>'
   node $cli brief
   ```

   Expect the newly approved decision to receive `D-2`. Repeat with another
   queued decision and `review reject '<QUEUE-ID>'`: rejection must leave
   counters unchanged. The next approved decision should get `D-3`.

4. Verify keys resolve and appear in user output:

   ```powershell
   node $cli task show T-2
   node $cli task compile T-2
   node $cli task done T-2
   ```

   Expect each to identify `T-2`. Open the compiled prompt: it should include
   the task key and relevant record keys. In the sandbox-connected MCP client,
   check `get_record` using `D-1`, and `task_done` using `T-3`; results should
   identify the same records/tasks as their internal IDs. If running this branch
   in a test web deployment, check `?task=T-2` and `?item=D-1`: they should mark
   the same rows as links using their internal IDs.

5. Exercise legacy backfill **only in this disposable sandbox**:

   ```powershell
   $projectPath = '.teamctx\project.json'
   $legacy = Get-Content -Raw $projectPath | ConvertFrom-Json
   foreach ($node in @($legacy.records) + @($legacy.tasks)) {
     $node.PSObject.Properties.Remove('key')
   }
   $legacyJson = $legacy | ConvertTo-Json -Depth 30
   [IO.File]::WriteAllText((Join-Path $PWD $projectPath), $legacyJson, [Text.UTF8Encoding]::new($false))
   ```

   Use the internal ID for this first write: the task currently has no key to
   resolve. The write should backfill all existing tasks and records:

   ```powershell
   $legacyTaskId = ($legacy.tasks | Where-Object title -eq 'Contact Acme').id
   node $cli task assign $legacyTaskId --owner 'QA'
   $first = Get-Content -Raw $projectPath | ConvertFrom-Json
   $first.records | Select-Object id,key,createdAt
   $first.tasks | Select-Object id,key,createdAt
   $keysBefore = (@($first.records) + @($first.tasks) | Select-Object id,key | ConvertTo-Json -Compress)
   node $cli task assign $legacyTaskId --owner 'QA again'
   $second = Get-Content -Raw $projectPath | ConvertFrom-Json
   $keysAfter = (@($second.records) + @($second.tasks) | Select-Object id,key | ConvertTo-Json -Compress)
   $keysBefore -eq $keysAfter
   ```

   Expect every existing task/record to gain a key in creation order. Existing
   counters are respected, so these newly assigned keys can start above one.
   The second comparison must be `True`: a later write never remints them.
   Cross-workstream allocation and concurrent writes are covered by the storage
   and command integration tests in `npm test`.

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
