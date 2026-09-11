import { existsSync } from 'fs';
import { resolve as pathResolve, join } from 'path';
import dotenv from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  getTeamctxDir,
  readConfig, readWorkstream, readProject, listWorkstreamIds,
  readTree, readTreeMd,
  readRoleFile,
  readContributions,
} from '../src/storage.js';
import { answerQuestion } from '../src/context.js';
import { commitContext } from '../src/git.js';
import { connectorUrl, originRemote } from '../cli/commands/connect.core.js';
import { migrateIfNeeded } from '../src/migrate.js';
import { computeStats } from '../src/metrics.js';
import { initProject } from '../cli/commands/init.core.js';
import {
  listPendingReviews, approveReview, rejectReview,
} from '../cli/commands/review.core.js';
import {
  createSnapshot, approveSnapshot, rejectSnapshot,
  listAllSnapshots, getSnapshot, getCurrentSnapshot,
} from '../cli/commands/snapshot.core.js';
import {
  listRoles as coreListRoles, suggestRoles as coreSuggestRoles,
  addRoleFull, assignRole,
} from '../cli/commands/role.core.js';
import {
  listAllWorkstreams, suggestWorkstreamSplits, splitWorkstreams, useWorkstream,
} from '../cli/commands/workstream.core.js';
import { contributeCore } from '../cli/commands/contribute.core.js';
import {
  listTasksFiltered, getTask, addTask, setTaskStatus, assignTask, removeTask, compileTask,
} from '../cli/commands/task.core.js';
import { listMembers, addMember, removeMember, setMemberWorkstreams } from '../cli/commands/member.core.js';
import { reflectWorkstream } from '../cli/commands/reflect.core.js';
import { getConfig, setConfig, repairManagerGate, setReviewPolicy } from '../cli/commands/config.core.js';
import { resolveActor } from '../src/actor.js';
import { canApprove, managerKeys } from '../src/review.js';
import {
  scopeFor, assertInScope, inScope, visibleWorkstreams, defaultWorkstream,
} from '../src/member-scope.js';
import { isProjectLevel, resolveTarget, targetLabel } from '../src/project-level.js';
import { resolveActiveWorkstream, resolveIdentity, resolveDisplayName } from '../src/prefs.js';
import { isBrokenGate } from '../src/manager-repair.js';
import { INSTRUCTIONS } from './instructions.js';

export function resolveProjectDir(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const flagIdx = argv.findIndex(a => a === '--project' || a === '-p');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return pathResolve(argv[flagIdx + 1]);
  const eqArg = argv.find(a => a.startsWith('--project='));
  if (eqArg) return pathResolve(eqArg.slice('--project='.length));
  if (env.TEAMCTX_PROJECT_DIR) return pathResolve(env.TEAMCTX_PROJECT_DIR);
  return cwd;
}

const RISKY = '⚠ RISKY: ';
const REPORT = ' The client should report the returned reportBack string to the user after calling.';

export const TOOLS = [
  // Tier 0 — read-only
  {
    name: 'get_context',
    description: "Fetch the whole project: its own Why/What/How tree first, as `id: null`, then each workstream the caller may see. The project tree is the base every workstream inherits — a workstream's own entry holds only what is specific to it, so read both. Returns { workstreams: [{id, tree}, ...] }.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_workstreams',
    description: 'List the workstreams configured for the current project (id + name for each).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_workstream',
    description: "Fetch a single workstream tree by id. Omit the id for the project's own tree — the base every workstream inherits, and where a project with no workstreams keeps everything.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_role_context',
    description: "Fetch a role's compiled context markdown by role slug.",
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string' } },
      required: ['role'], additionalProperties: false,
    },
  },
  {
    name: 'list_roles',
    description: 'List all defined roles (slug, name, workstream).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_snapshots',
    description: 'List all snapshots with their status; also returns the current-approved id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_snapshot',
    description: 'Fetch a snapshot by id or unique prefix.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'snapshot id or unique prefix' } },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'get_current_snapshot',
    description: 'Fetch the current-approved snapshot pointer (id, message, approvedBy, approvedAt).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_pending_reviews',
    description: 'List all queued contributions awaiting manager review (id, author, workstream, summary, operations).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_status',
    description: "**Call this first when you do not know where you are.** Answers who is calling, which project, whether it is set up at all, and whether the caller is the manager — all in one read. `managerGateBroken: true` means the gate is a display name nobody can match, so every approval on this project is already failing — tell the user plainly and offer repair_manager_gate if they set the project up. Returns project name, provider, model, manager identity, workstreams with why-counts, roles, contribution/decision totals. `me` and `activeWorkstream` are the calling user's, not the project defaults. Read-only.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_connect_url',
    description: "**Reach for this after adding someone to the project** — it is what you send them. The URL a team member pastes into their AI client; they add it as a custom connector and sign in. Read-only. When the project has no deploy URL recorded the server cannot build the link — hand over the address of the connector this conversation is already using instead, which is the same project, rather than telling the user there is no link.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_config',
    description: "Return the public project config (provider, model, manager, deployUrl, autoPush, roles, workstreams), plus `me` and `activeWorkstream` resolved for the calling user. `projectDefaults` holds what the repo's config.json says. Never returns API keys.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ask',
    description: "Ask a question answered from the team's shared context; optionally include a role's perspective. Pass audit=true to append a per-contribution source list to the answer.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        role: { type: 'string', description: 'Optional role slug to add role-specific context' },
        workstream: { type: 'string', description: "Answer from one workstream. Omit for the caller's own — which is the whole project unless they are scoped to less." },
        audit: { type: 'boolean', description: 'When true, append a detailed source list; when false (default), append a one-line contributor summary' },
      },
      required: ['question'], additionalProperties: false,
    },
  },
  {
    name: 'suggest_roles',
    description: 'AI-suggest 3-5 roles for a workstream (dry-run; does not create them). Use role_add to create the chosen ones.',
    inputSchema: {
      type: 'object',
      properties: { workstream: { type: 'string', description: 'Workstream id (defaults to active or main)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'suggest_workstream_splits',
    description: 'AI-propose sub-workstream splits for the active workstream (dry-run). Returns { splits: [{name, rationale, whyIds, whys}], leftover }. Use workstream_split to accept.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_stats',
    description: "Team metrics computed from the project's own history — contribution cadence by author, approval flow and median review wait, context freshness per workstream, task flow. Read-only, no AI call, nothing leaves the machine. Numbers are grounded: report them as returned rather than estimating. `approvals.historyAvailable` is false when git history is unreachable (hosted mode), in which case `decided`/`approved`/`medianHours` are null and must not be reported as zero. `approvals.waits` lists each decided item slowest first with its wait in hours and whether it was rejected — use it to name what actually stalled rather than summarising the median, which hides an outlier by design.",
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Start of the window as a date (default: last 28 days)' },
        workstream: { type: 'string', description: 'Narrow every metric to one workstream' },
      },
      additionalProperties: false,
    },
  },

  {
    name: 'list_tasks',
    description: "**Reach for this when somebody asks what they should be working on.** Pass mine:true for their own — never ask them what they are called, the server already knows who is calling. Defaults to open tasks in the caller's active workstream; pass all:true for every status across every workstream, which is what \"did we finish X\" means. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'open | done' },
        mine: { type: 'boolean', description: "Only tasks belonging to the caller — this is what \"my tasks\" means. Cannot be combined with owner." },
        owner: { type: 'string', description: 'Someone else, by the display name shown in the task list' },
        workstream: { type: 'string' },
        all: { type: 'boolean', description: 'Every status, every workstream' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_members',
    description: 'List the people on this project: name, GitHub login, email, who added them and when. Read-only. A member is a person the manager has put on the roster; it is not the same as having access to the repository.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_task',
    description: 'Return one task by id or unique id prefix: title, owner, status, workstream, created/done/compiled timestamps, and the prompt file path if one has been compiled. Read-only. Use task_compile to get the prompt text itself.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id, or a unique prefix of one' } },
      required: ['id'],
      additionalProperties: false,
    },
  },

  // Tier 1 — additive writes
  {
    name: 'contribute',
    description: "**This is how anything gets into the shared context — there is no separate import step.** Reach for it both when a manager tells you what the project is about and when somebody sends finished work back. Defaults to enqueueing for the manager's review, so tell the user it was sent for review, not that it was added. **The exception is a project's first contribution**: when get_status shows totalWhys:0, pass apply:true so it lands rather than waiting on the manager to approve their own opening message. apply:true writes immediately and requires the caller to be the manager. Optional decision:true tags it as a first-class decision. Returns { id, mode: \"queued\"|\"applied\"|\"no-op\", summary, operations, reportBack }.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        workstream: { type: 'string' },
        author: { type: 'string' },
        decision: { type: 'boolean' },
        apply: { type: 'boolean', description: 'Write immediately; skips the review queue' },
      },
      required: ['text'], additionalProperties: false,
    },
  },
  {
    name: 'submit_contribution',
    description: 'Deprecated alias for `contribute` — kept for one release. Prefer `contribute`.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' }, workstream: { type: 'string' }, author: { type: 'string' },
      },
      required: ['text'], additionalProperties: false,
    },
  },

  {
    name: 'task_add',
    description: '**Reach for this to turn what a manager wants into work somebody can pick up.** Creates a task and commits it; defaults to the caller as owner and their active workstream. Set compile:true to compile its prompt in the same call — the compiled prompt is the thing a person actually acts on, so this is usually what you want. It spends an AI call, so confirm the title with the user first; the result then carries the compiled markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        owner: { type: 'string', description: 'Defaults to the calling user' },
        workstream: { type: 'string', description: 'Defaults to the active workstream' },
        compile: { type: 'boolean', description: 'Also compile the prompt (AI call)' },
        role: { type: 'string', description: 'With compile:true, frame the prompt for this role slug' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_done',
    description: 'Mark a task done and commit. Returns unchanged:true without committing if it was already done.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_reopen',
    description: 'Reopen a done task and commit. Returns unchanged:true without committing if it was already open.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_assign',
    description: 'Reassign a task to a different owner and commit.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, owner: { type: 'string' } },
      required: ['id', 'owner'],
      additionalProperties: false,
    },
  },

  // Tier 2 — structural / gated
  {
    name: 'init',
    description: RISKY + 'creates a new teamctx project (.teamctx/ config, initial workstream, initial commit) in the resolved project directory. Refuses if already initialized. Requires the project dir to be a git repository. The caller becomes the initial author (config.me); no manager gate is set by default. Confirm all params with the user before calling.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Human project name' },
        me: { type: 'string', description: 'Your name/handle on contributions' },
        provider: { type: 'string', enum: ['anthropic', 'openai', 'gemini'] },
        model: { type: 'string', description: 'Optional; falls back to provider default' },
        autoPush: { type: 'boolean' },
        deployUrl: { type: 'string' },
        githubRawBase: { type: 'string' },
        managerEmail: { type: 'string' },
      },
      required: ['project', 'me'], additionalProperties: false,
    },
  },
  {
    name: 'role_add',
    description: RISKY + 'creates a new role, generates its role-context file, and commits. Not gated, but role structure changes the shape of every downstream regeneration. Confirm name + responsibilities with the user first.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        responsibilities: { type: 'string' },
        excludes: { type: 'string' },
        email: { type: 'string' },
        workstream: { type: 'string' },
      },
      required: ['name', 'responsibilities'], additionalProperties: false,
    },
  },
  {
    name: 'role_assign',
    description: RISKY + 'moves a role to a different workstream and regenerates its context file. Confirm the target workstream with the user.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, workstream: { type: 'string' } },
      required: ['slug', 'workstream'], additionalProperties: false,
    },
  },
  {
    name: 'workstream_split',
    description: RISKY + 'creates new sub-workstreams by moving Why nodes out of the active one. Structural change — reshapes how the project is organized. Callers should pass the accepted array returned (or filtered) from suggest_workstream_splits. Confirm the split names + role moves with the user before calling.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        accepted: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              whyIds: { type: 'array', items: { type: 'string' } },
              moveRoles: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'whyIds'],
          },
        },
      },
      required: ['accepted'], additionalProperties: false,
    },
  },
  {
    name: 'workstream_use',
    description: 'Changes the calling user\'s active workstream. All their subsequent contribute/ask/reflect calls without an explicit workstream target this one. Personal setting — it is not written to the repo and does not affect other users.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Workstream to move to. Omit to go back to the project itself, which is where somebody works before they pick a strand.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'review_approve',
    description: RISKY + 'applies a queued contribution to shared context, regenerates the bound role files, and commits. Irreversible without a git revert. Manager-gated against the authenticated caller; there is no way to assert a different identity. Report the queue item author + summary to the user before calling; report the resulting operations after.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Queue item id (from list_pending_reviews)' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'review_reject',
    description: RISKY + 'archives a queued contribution to rejected/ with an optional reason and commits. Manager-gated. Confirm intent with the user before calling.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'snapshot_create',
    description: RISKY + 'freezes every workstream as a versioned pending snapshot and commits. Not gated (creation is safe), but the manager needs to approve it via snapshot_approve for it to become current. Confirm the message with the user.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'snapshot_approve',
    description: RISKY + 'approves a pending snapshot and updates the current-approved pointer. Manager-gated. Report the snapshot summary to the user before calling.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Snapshot id or unique prefix' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'snapshot_reject',
    description: RISKY + 'rejects a pending snapshot with an optional reason. Manager-gated. Confirm with the user.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, reason: { type: 'string' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'reflect',
    description: RISKY + 'runs an AI rewrite of the workstream tree — condenses, deduplicates, and reorganizes Why nodes. It replaces the whole tree with the model\'s output: there is no diff, no queue, and nothing smaller to review, so it can lose statements other people wrote. Manager-only unless the project\'s review policy is "none". Confirm the scope with the user first, and say plainly that this rewrites everything rather than adding to it.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: { workstream: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'repair_manager_gate',
    description: RISKY + "re-pins a manager gate that is a display name rather than an identity — projects created on the web before this was fixed carry one, and nobody can match it, so every approval fails. Refuses unless the gate is broken **and** the caller created the project, read from the commit that added .teamctx/config.json. Not a way to take over a project: against a working gate, or from anybody but the creator, it refuses." + REPORT,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_review_policy',
    description: RISKY + "chooses how much of a contribution waits for the manager's approval. Manager-gated against the authenticated caller, and deliberately not reachable through config_set: a caller who can set this to \"none\" can then write anything. \"all\" queues every contribution. \"additive\" lets contributions that only add land immediately and queues anything that edits or deletes an existing statement. \"none\" applies everything and also lets any member run reflect, which rewrites the whole shared context. Say what changes in plain language and confirm before calling." + REPORT,
    inputSchema: {
      type: 'object',
      properties: { policy: { type: 'string', enum: ['all', 'additive', 'none'] } },
      required: ['policy'], additionalProperties: false,
    },
  },
  {
    name: 'config_set',
    description: RISKY + "writes a single config key. Project-wide keys: provider, model, githubRawBase, managerEmail, deployUrl, autoPush — these change the project for everyone. Personal key: name — the display name used on the caller's own contributions, stored against them and never written to the repo. Who may approve is fixed at init and cannot be changed here. Changing `provider` may reset `model`." + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          enum: ['provider', 'model', 'githubRawBase', 'manager', 'managerKey', 'managerEmail', 'deployUrl', 'autoPush', 'name'],
        },
        value: { description: 'String, boolean, or empty string to clear' },
      },
      required: ['key', 'value'], additionalProperties: false,
    },
  },
  {
    name: 'member_add',
    description: RISKY + "adds a person to the project roster and commits. Manager-gated against the authenticated caller. Takes a GitHub username or an email address — only a username can be invited to the repository, since GitHub's collaborator endpoint takes no email. Set invite:true to also send a repository invitation, which they must accept before they can clone. Without it they are on the roster but have no access, which looks the same to a manager and is not. Pass `workstreams` to put them on named parts of the work rather than the whole project. Refused while the project has nothing written in it, or while a named workstream has nothing of its own — somebody arriving must have something to read; the refusal says what to add, and `contribute` is how you add it. Confirm the person and whether to invite before calling. Returns `connectUrl` — the link they need to reach the project from their own assistant — so send it to them in the same reply; adding somebody without giving them the link invites nobody. When it comes back null, say why rather than reporting a clean success." + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'GitHub username, or an email address' },
        name: { type: 'string', description: 'Display name, if different from the handle' },
        workstreams: {
          type: 'array', items: { type: 'string' },
          description: 'Workstreams they may reach. Omit for the whole project, which is the default.',
        },
        invite: { type: 'boolean', description: 'Also invite them to the GitHub repository' },
        permission: { type: 'string', description: 'pull | triage | push | maintain | admin (default push)' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'member_scope',
    description: RISKY + "changes which workstreams an existing member may reach, and commits. Manager-gated against the authenticated caller. Pass `workstreams` to limit them; omit it to give them the whole project again, which is what every member has by default. Enforced for somebody who signs in with Google and reaches the project through this server; advisory for a GitHub collaborator, who holds a clone and reads every workstream in it — say which of the two they are rather than implying a wall that is not there. Refused while a workstream named has nothing written in it, for the same reason `member_add` is. Confirm the person and the workstreams before calling." + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'GitHub username, email address, or the name they are on the roster under' },
        workstreams: {
          type: 'array', items: { type: 'string' },
          description: 'Workstreams they may reach. Omit to clear the scope and return them to the whole project.',
        },
      },
      required: ['ref'], additionalProperties: false,
    },
  },
  {
    name: 'member_rm',
    description: RISKY + 'removes a person from the project roster and commits. Manager-gated. Does **not** revoke their GitHub access — that has to be done on GitHub, and saying otherwise would leave a manager believing access was withdrawn when it was not.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Username, email, name or actor key' } },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_rm',
    description: RISKY + 'permanently deletes a task and its compiled prompt file, then commits. There is no undo short of a git revert. Report the task title to the user and confirm before calling.' + REPORT,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_compile',
    description: RISKY + "**Reach for this when somebody is ready to start a task** — it is the brief they work from. Spends an AI call to build a prompt from the workstream's shared context, the role's responsibilities and recent decisions, then overwrites any existing prompt and commits. Returns the markdown itself, not just a path: hand it to them, the caller usually cannot read the file. Skips the AI call and returns the cached prompt with alreadyCompiled:true when nothing has changed; pass force:true to regenerate anyway. Do not call in a loop." + REPORT,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        role: { type: 'string', description: 'Role slug to frame the prompt for' },
        force: { type: 'boolean', description: 'Regenerate even if the Whys are unchanged' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

function reportBackContribute(r) {
  // `where`, not the raw id. At project level the id is `null`, and the client
  // is told to read this string back word for word — so an unsplit project,
  // which is most of them, reported work landing on workstream "null".
  const where = r.workstream === null ? 'the project' : `workstream "${r.workstream}"`;
  if (r.mode === 'no-op') return `Tell the user: contribution logged for ${where} but the AI proposed no changes to the tree.`;
  if (r.mode === 'queued') return `Tell the user: contribution ${r.id} queued for manager approval on ${where} (${r.operations.length} op${r.operations.length === 1 ? '' : 's'}). Manager must run \`teamctx review approve ${r.id}\` or call the review_approve tool.`;
  return `Tell the user: contribution ${r.id} applied to ${where} (${r.operations.length} op${r.operations.length === 1 ? '' : 's'})${r.rolesRegenerated?.length ? `, regenerated roles: ${r.rolesRegenerated.join(', ')}` : ''}${r.pushed ? ', committed and pushed' : ', committed'}.`;
}

export function makeHandlers(projectRoot) {
  // `projectRoot` is either a filesystem path (local/stdio mode) or a hosted
  // context object `{__backend:'github', ...}`. In hosted mode, storage
  // dispatch ignores the `dir` arg and pulls from the ambient GithubSession
  // (see src/session-context.js), so any truthy placeholder here is fine.
  const isHosted = typeof projectRoot === 'object' && projectRoot?.__backend === 'github';
  // Some tools (init) run before .teamctx/ exists, so they take projectRoot directly.
  // migrateIfNeeded touches the filesystem directly, so it only runs locally.
  let migrated = false;
  const dir = () => {
    // Hosted used to return before this, because the migration touched the
    // filesystem directly. It goes through the storage layer now, and skipping
    // it left every hosted project half-migrated — `main` alive beside a project
    // tree, which is the one state nothing is written to expect.
    const teamctxDir = isHosted ? projectRoot : getTeamctxDir(projectRoot);
    if (!migrated) {
      try { migrateIfNeeded(teamctxDir); } catch { /* best-effort */ }
      migrated = true;
    }
    return teamctxDir;
  };

  // Local (stdio) mode has no ambient actor, so this falls through to the git
  // identity in the project directory. Hosted mode gets one seeded per request
  // from the OAuth session — see api/mcp/[owner]/[repo].js.
  // In hosted mode `projectRoot` is a context object, not a path — never hand it
  // to anything that shells out to git.
  const gitCwd = isHosted ? undefined : projectRoot;

  const who = async (teamctxDir, config) => {
    const actor = await resolveActor({ config, cwd: gitCwd });
    const identity = await resolveIdentity({ actor, config, teamctxDir });
    return {
      actor,
      name: identity.name,
      // Where the *name* came from. 'override' when the user set their own,
      // which is not the same as where the actor was authenticated.
      nameSource: identity.source,
      workstream: await resolveActiveWorkstream({ actor, config, teamctxDir }),
    };
  };

  /**
   * Which workstreams this caller may reach, or null for the whole project.
   *
   * Worked out per request rather than carried on the actor: the roster lives
   * in the repo, so a scope changed by the manager takes effect on the next
   * call rather than whenever a session happens to be rebuilt.
   */
  const scope = async (teamctxDir, config) => {
    const actor = await resolveActor({ config, cwd: gitCwd });
    const displayName = await resolveDisplayName({ actor, config, teamctxDir });
    return scopeFor(config, actor, {
      isManager: canApprove(config, { actor, displayName }),
    });
  };

  /**
   * The workstream a call should act on.
   *
   * An id the caller named is checked; one they did not is their own default,
   * clamped to what they may reach. So an agent can pass a workstream when the
   * user names one and leave it out when they do not, and neither choice is
   * what decides the boundary — omitting it cannot widen anything.
   */
  const targetWorkstream = async (teamctxDir, config, named) => {
    const allowed = await scope(teamctxDir, config);
    // `main` still arrives from habit and from older clients; it means the
    // project, which is not a workstream and is not scoped.
    if (named) {
      const target = resolveTarget(named);
      return isProjectLevel(target) ? null : assertInScope(allowed, target);
    }
    const actor = await resolveActor({ config, cwd: gitCwd });
    const chosen = resolveTarget(await resolveActiveWorkstream({ actor, config, teamctxDir }));
    return defaultWorkstream(allowed, chosen);
  };

  /**
   * A snapshot carries every tree at one moment, so handing one over whole is
   * the same leak as an unfiltered `get_context` — and it reaches further,
   * because a snapshot is history the caller was never meant to browse.
   *
   * The legacy `shared` key is `main`'s tree, which is project level and in
   * everybody's scope, so it stays.
   */
  const visibleSnapshot = (snapshot, allowed) => {
    if (!allowed || !snapshot) return snapshot;
    return {
      ...snapshot,
      workstreams: (snapshot.workstreams || []).filter(w => inScope(allowed, resolveTarget(w.id))),
    };
  };

  /**
   * The workstream a task lives in, checked against the caller's scope.
   *
   * A scope that stopped at the workstream tools would be walked around by
   * naming a task instead — and a task's compiled prompt carries its whole
   * workstream's tree, so that is the widest door of the lot.
   *
   * An id that matches nothing falls through deliberately: the core's own "no
   * task matches" is a better answer than a scope error, and says no more.
   */
  const assertTaskInScope = async (teamctxDir, id) => {
    const allowed = await scope(teamctxDir, readConfig(teamctxDir));
    if (!allowed) return;
    let target;
    try { target = resolveTarget(getTask({ id, teamctxDir }).workstream); }
    catch { return; }
    assertInScope(allowed, target);
  };

  return {
    async get_context() {
      const teamctxDir = dir();
      const config = readConfig(teamctxDir);
      const ids = new Set([
        ...(config.workstreams || []).map(w => w.id),
        ...listWorkstreamIds(teamctxDir),
      ]);
      const allowed = await scope(teamctxDir, config);
      // The project tree first, always. It is what every workstream inherits,
      // and leaving it out meant a contribution to the project landed correctly
      // and then read as lost — nothing returned it, so the same question gave
      // a different answer each time as writes piled up unseen.
      const workstreams = [
        { id: null, tree: readProject(teamctxDir) },
        ...visibleWorkstreams(allowed, [...ids].sort())
          .map(id => ({ id, tree: readWorkstream(id, teamctxDir) })),
      ];
      return textResult({ workstreams, ...(allowed ? { scopedTo: allowed } : {}) });
    },

    async list_workstreams() {
      const teamctxDir = dir();
      const allowed = await scope(teamctxDir, readConfig(teamctxDir));
      const all = await listAllWorkstreams({ teamctxDir, projectDir: gitCwd });
      const ids = visibleWorkstreams(allowed, all.map(w => w.id));
      return textResult({
        workstreams: all.filter(w => ids.includes(w.id)),
        ...(allowed ? { scopedTo: allowed } : {}),
      });
    },

    async get_workstream({ id } = {}) {
      const teamctxDir = dir();
      if (isProjectLevel(id)) return textResult(readProject(teamctxDir));
      assertInScope(await scope(teamctxDir, readConfig(teamctxDir)), id);
      return textResult(readWorkstream(id, teamctxDir));
    },

    async get_role_context({ role }) {
      const teamctxDir = dir();
      const config = readConfig(teamctxDir);
      // A role is a compiled view of one workstream, so reading it is reading
      // that workstream — a scope that stopped at get_workstream would be
      // walked around by asking for the role instead.
      const found = (config.roles || []).find(r => r.slug === role);
      if (found) assertInScope(await scope(teamctxDir, config), resolveTarget(found.workstream));
      return textResult(readRoleFile(role, teamctxDir));
    },

    async list_roles() {
      const teamctxDir = dir();
      const allowed = await scope(teamctxDir, readConfig(teamctxDir));
      // A role name and the workstream it belongs to are two of the things a
      // scope is meant to keep back — `get_role_context` already refuses the
      // file, and listing it is how the caller learns what to ask for.
      const roles = coreListRoles({ teamctxDir })
        .filter(r => inScope(allowed, resolveTarget(r.workstream)));
      return textResult({ roles, ...(allowed ? { scopedTo: allowed } : {}) });
    },

    async list_snapshots() {
      const teamctxDir = dir();
      const allowed = await scope(teamctxDir, readConfig(teamctxDir));
      const r = listAllSnapshots({ teamctxDir });
      // Every entry here is a whole snapshot, trees included — this listing was
      // a wider door than `get_snapshot`, which had already been closed.
      return textResult({
        ...r,
        snapshots: (r.snapshots || []).map(sn => visibleSnapshot(sn, allowed)),
        ...(allowed ? { scopedTo: allowed } : {}),
      });
    },

    async get_snapshot({ id }) {
      const teamctxDir = dir();
      const allowed = await scope(teamctxDir, readConfig(teamctxDir));
      const r = getSnapshot({ prefix: id, teamctxDir });
      if (!allowed) return textResult(r);
      // A snapshot is every tree at one moment, so handing one over whole is
      // the same leak as `get_context` without a filter.
      // Both halves: `snapshot.workstreams` and the top-level `workstreams` are
      // the same array, so filtering one and spreading the other handed over
      // every tree anyway.
      const filtered = visibleSnapshot(r.snapshot, allowed);
      return textResult({
        ...r,
        snapshot: filtered,
        workstreams: filtered.workstreams || [],
        scopedTo: allowed,
      });
    },

    async get_current_snapshot() {
      return textResult({ current: getCurrentSnapshot({ teamctxDir: dir() }) });
    },

    async list_pending_reviews() {
      const teamctxDir = dir();
      const allowed = await scope(teamctxDir, readConfig(teamctxDir));
      // A queued item carries its summary and its operations — the content of a
      // sibling workstream, waiting to be approved into it. Only the manager
      // acts on these, and a manager is never scoped.
      const pending = (await listPendingReviews({ teamctxDir }))
        .filter(item => inScope(allowed, resolveTarget(item.workstream)));
      return textResult({ pending, ...(allowed ? { scopedTo: allowed } : {}) });
    },

    async get_status() {
      const teamctxDir = dir();
      const config = readConfig(teamctxDir);
      const all = await listAllWorkstreams({ teamctxDir, projectDir: gitCwd });
      // Scoped here as well as everywhere else. Listing a workstream a caller
      // cannot open is worse than hiding it: they see a name, ask for it, are
      // told it does not exist, and conclude the project is broken.
      const allowed = await scope(teamctxDir, config);
      const visible = visibleWorkstreams(allowed, all.map(w => w.id));
      const workstreams = all.filter(w => visible.includes(w.id));
      const project = readProject(teamctxDir);
      const contributions = readContributions(teamctxDir);
      const decisions = contributions.filter(c => c.tagged === 'decision');
      const me = await who(teamctxDir, config);
      return textResult({
        project: config.project,
        provider: config.provider || 'anthropic',
        model: config.model,
        // The gate, not `config.manager`. That field is the legacy display-name
        // one and is empty on every project created since; reading it reported
        // "no manager" for projects that had one, which is the question this
        // field exists to answer.
        manager: managerKeys(config)[0] || config.manager || null,
        managerDisplayName: config.manager || null,
        // Named here because this is where an agent orients, and a broken gate
        // is otherwise only discovered at the moment an approval is refused —
        // which is late, and reads as a bug rather than a fixable state.
        managerGateBroken: isBrokenGate(config),
        // Who *this caller* is and where *they* are working — not the shared
        // config.me / config.activeWorkstream, which are only the defaults.
        me: me.name,
        meSource: me.nameSource,
        actorSource: me.actor.source,
        activeWorkstream: me.workstream,
        projectDefaults: { me: config.me, activeWorkstream: config.activeWorkstream || null },
        // The project tree counts. Without it a contribution to the project
        // lands correctly and then reads as lost: totalWhys does not move and no
        // workstream shows it.
        projectWhys: (project.whys || []).length,
        totalWhys: (project.whys || []).length + workstreams.reduce((n, w) => n + w.whyCount, 0),
        workstreams,
        ...(allowed ? { scopedTo: allowed } : {}),
        contributions: { total: contributions.length, decisions: decisions.length },
        // Filtered for the same reason `list_roles` is: a role name and the
        // workstream behind it are two of the things a scope keeps back, and
        // this response hides those workstream ids three lines above.
        roles: (config.roles || [])
          .map(r => ({ slug: r.slug, name: r.name, workstream: resolveTarget(r.workstream) }))
          .filter(r => inScope(allowed, r.workstream)),
      });
    },

    async list_members() {
      return textResult({ members: listMembers({ teamctxDir: dir() }) });
    },

    /**
     * The link a person actually needs, resolved the same way for whoever asks.
     *
     * `member_add` and `get_connect_url` both need it, and the interesting case
     * is the failure: a project with no `deployUrl` has nothing to hand out, so
     * "added to the project" is true and useless — the manager walks away
     * believing somebody was invited who cannot reach anything.
     */
    async connectUrl() {
      const config = readConfig(dir());
      // A recorded `deployUrl` wins, because a project may be served from a
      // different address than the one this request happened to arrive at. When
      // there is none, the request's own host is a better answer than refusing:
      // it is where the caller already is. A clone has no request, so there it
      // stays a genuine prerequisite.
      const deployUrl = config.deployUrl || (isHosted ? projectRoot.baseUrl : '') || '';
      // Hosted already knows the repository from the request URL; a clone has to
      // read its remote, which stays right through a rename.
      const where = isHosted
        ? { owner: projectRoot.owner, repo: projectRoot.repo }
        : { remote: await originRemote(gitCwd) };
      try {
        return { ok: true, ...connectorUrl({ deployUrl, ...where }) };
      } catch (err) {
        return { ok: false, error: err.message, code: err.code };
      }
    },

    async member_add(args = {}) {
      const r = await addMember({
        ref: args.ref,
        name: args.name,
        workstreams: args.workstreams,
        invite: !!args.invite,
        permission: args.permission || 'push',
        // Hosted requests carry the repo they are scoped to, and the caller's
        // own token already holds the `repo` scope the invite needs.
        owner: projectRoot?.owner,
        repo: projectRoot?.repo,
        ghToken: projectRoot?.ghToken,
        teamctxDir: dir(),
        projectDir: gitCwd,
      });

      const access = r.invite?.invited ? ' and invited to the repository'
        : r.invite?.alreadyCollaborator ? ' (already had repository access)'
        : r.invite?.error ? ` — the repository invite failed: ${r.invite.error}`
        : r.member.login ? ' — not invited to the repository, so they cannot clone it yet'
        : '';

      // Returned here rather than left to a second call. Adding somebody is
      // only half of inviting them, and the other half was being skipped: the
      // roster entry lands, the tool reports success, and nobody is ever sent
      // anything. So the link — or the reason there isn't one — travels with
      // the thing that creates the need for it.
      const link = await this.connectUrl();
      const next = link.ok
        ? ` Send them this link to join: ${link.url} — they add it as a custom connector and sign in.`
        : link.code === 'NO_DEPLOY_URL'
          ? ' This project has no deploy URL recorded, so the server could not build the link. '
            + 'You already have it: give them the address of the connector this conversation is using, '
            + 'which is the same project. Then have the manager set config_set key "deployUrl" to its '
            + 'origin so the next invite does not need you to.'
          : ` The link could not be worked out: ${link.error}`;

      return textResult({
        ...r,
        connectUrl: link.ok ? link.url : null,
        connectUrlError: link.ok ? null : link.error,
        reportBack: `${r.member.name} added to the project${access}.${next}`,
      });
    },

    async member_scope(args = {}) {
      const r = await setMemberWorkstreams({
        ref: args.ref,
        workstreams: args.workstreams,
        teamctxDir: dir(),
        projectDir: gitCwd,
      });
      const where = r.workstreams
        ? `now on ${r.workstreams.join(', ')}`
        : 'now on the whole project';
      // Said every time rather than only when scoping, because the manager is
      // most likely to believe in the wall at the moment they put one up.
      const honest = r.workstreams && r.member.login
        ? ' Advisory for them: a GitHub collaborator holds a clone and reads every workstream in it.'
        : '';
      return textResult({ ...r, reportBack: `${r.member.name} is ${where}.${honest}` });
    },

    async member_rm(args = {}) {
      const r = await removeMember({ ref: args.ref, teamctxDir: dir(), projectDir: gitCwd });
      return textResult({
        ...r,
        reportBack: `${r.member.name} removed from the roster.`
          + (r.stillHasRepoAccess ? ' Their GitHub access is unchanged.' : ''),
      });
    },

    async list_tasks(args = {}) {
      const teamctxDir = dir();
      const config = readConfig(teamctxDir);
      const actor = await resolveActor({ config, cwd: gitCwd });
      const allowed = await scope(teamctxDir, config);
      const activeWorkstream = await targetWorkstream(teamctxDir, config, args.workstream);
      // The server already knows who is calling, so "what are my tasks?" does
      // not need the caller to know what this project calls them.
      const me = await resolveDisplayName({ actor, config, teamctxDir });
      const r = listTasksFiltered({
        ...args, activeWorkstream, teamctxDir, me, myKey: actor.key,
      });
      // Filtered after the fact as well as before: `all: true` asks across
      // every workstream, and a scope has to survive that rather than be
      // undone by an argument.
      const tasks = allowed
        ? (r.tasks || []).filter(t => inScope(allowed, t.workstream))
        : r.tasks;
      return textResult({ ...r, tasks, ...(allowed ? { scopedTo: allowed } : {}) });
    },

    async get_task(args = {}) {
      const teamctxDir = dir();
      await assertTaskInScope(teamctxDir, args.id);
      return textResult(getTask({ id: args.id, teamctxDir }));
    },

    async task_add(args = {}) {
      const teamctxDir = dir();
      const added = await addTask({
        title: args.title,
        owner: args.owner,
        // Through the scope check rather than straight through: writing a task
        // into a workstream the caller cannot read is the same boundary in the
        // other direction.
        workstream: await targetWorkstream(teamctxDir, readConfig(teamctxDir), args.workstream),
        teamctxDir,
        projectDir: gitCwd,
      });

      // Raising a task and immediately compiling it is the common case, and two
      // round trips for one intention is friction an assistant feels more than
      // a person does. Kept opt-in because the second half spends an AI call.
      if (!args.compile) {
        return textResult({
          ...added,
          reportBack: `Task ${added.task.id} added, owned by ${added.task.owner}.`,
        });
      }

      const compiled = await compileTask({
        id: added.task.id,
        role: args.role,
        teamctxDir,
        projectDir: gitCwd,
      });
      return textResult({
        ...compiled,
        reportBack: `Task ${added.task.id} added and its prompt compiled`
          + `${compiled.role ? ` for role ${compiled.role}` : ''}.`,
      });
    },

    async task_done(args = {}) {
      const teamctxDir = dir();
      await assertTaskInScope(teamctxDir, args.id);
      const r = await setTaskStatus({
        id: args.id, status: 'done', teamctxDir, projectDir: gitCwd,
      });
      return textResult({
        ...r,
        reportBack: r.unchanged
          ? `Task ${r.task.id} was already done.`
          : `Task ${r.task.id} marked done.`,
      });
    },

    async task_reopen(args = {}) {
      const teamctxDir = dir();
      await assertTaskInScope(teamctxDir, args.id);
      const r = await setTaskStatus({
        id: args.id, status: 'open', teamctxDir, projectDir: gitCwd,
      });
      return textResult({
        ...r,
        reportBack: r.unchanged
          ? `Task ${r.task.id} was already open.`
          : `Task ${r.task.id} reopened.`,
      });
    },

    async task_assign(args = {}) {
      const teamctxDir = dir();
      await assertTaskInScope(teamctxDir, args.id);
      const r = await assignTask({
        id: args.id, owner: args.owner, teamctxDir, projectDir: gitCwd,
      });
      return textResult({ ...r, reportBack: `Task ${r.task.id} assigned to ${r.task.owner}.` });
    },

    async task_rm(args = {}) {
      const teamctxDir = dir();
      await assertTaskInScope(teamctxDir, args.id);
      const r = await removeTask({ id: args.id, teamctxDir, projectDir: gitCwd });
      return textResult({
        ...r,
        reportBack: `Task ${r.id} ("${r.title}") permanently removed from ${targetLabel(r.workstream, readConfig(teamctxDir).project)}.`,
      });
    },

    async task_compile(args = {}) {
      const teamctxDir = dir();
      // The compiled prompt embeds the task's whole workstream tree, so this is
      // the same bypass `get_role_context` had, and a wider one.
      await assertTaskInScope(teamctxDir, args.id);
      const r = await compileTask({
        id: args.id, role: args.role, force: !!args.force,
        teamctxDir, projectDir: gitCwd,
      });
      return textResult({
        ...r,
        reportBack: r.alreadyCompiled
          ? `Task ${r.task.id} was already compiled and its workstream has not changed — returned the existing prompt, no AI call spent.`
          : `Compiled a prompt for task ${r.task.id}${r.role ? ` framed for role ${r.role}` : ''}.`,
      });
    },

    async get_stats(args = {}) {
      // Hosted mode reaches the repo over the Git Data API, not a working copy,
      // so `queueTimeline` finds no git binary and the approval numbers come
      // back null. The tool description tells the client to say so rather than
      // report a zero.
      const teamctxDir = dir();
      const config = readConfig(teamctxDir);
      const allowed = await scope(teamctxDir, config);
      // A named workstream goes through the same check every other tool makes.
      // Unnamed, the numbers are project-wide, so the per-workstream breakdown
      // is filtered rather than the whole answer refused — a scoped member is
      // entitled to the project's own figures.
      // Resolved, then passed on as-is. `main` resolves to project level, which
      // is `null` — and `null || args.workstream` handed the raw "main" back to
      // a function that no longer knows any such workstream.
      const named = args.workstream === undefined
        ? undefined
        : assertInScope(allowed, resolveTarget(args.workstream));
      const stats = await computeStats({
        cwd: gitCwd, teamctxDir, since: args.since, workstream: named,
      });
      if (!allowed) return textResult(stats);
      return textResult({
        ...stats,
        freshness: (stats.freshness || []).filter(row => inScope(allowed, row.workstream)),
        scopedTo: allowed,
      });
    },

    async get_connect_url() {
      const config = readConfig(dir());
      const link = await this.connectUrl();
      if (link.ok) {
        const { ok, ...r } = link;
        return textResult({
          ...r,
          reportBack: `Connector URL for ${config.project || r.repo}: ${r.url} — send it to anyone on the project; they add it as a custom connector and sign in.`,
        });
      }
      return textResult({
        error: link.error,
        reportBack: link.code === 'NO_DEPLOY_URL'
          ? 'Tell the user: this project has no deploy URL recorded, so the server could not build the link — '
            + 'but you already have it. Give them the address of the connector this conversation is using; it is the '
            + 'same project. Then suggest setting config_set key "deployUrl" to its origin so this stops needing you.'
          : `Tell the user: ${link.error}.`,
      });
    },

    async get_config() {
      // `me` and `activeWorkstream` come back resolved for *this* caller;
      // `projectDefaults` carries what config.json says, which is only the
      // fallback for someone who has set no preference of their own.
      return textResult(await getConfig({ teamctxDir: dir(), projectDir: gitCwd }));
    },

    async ask(args = {}) {
      const { question, role, audit } = args;
      const teamctxDir = dir();
      const config = readConfig(teamctxDir);
      let roleMd = '';
      if (role) {
        const found = (config.roles || []).find(r => r.slug === role);
        if (!found) {
          const available = (config.roles || []).map(r => r.slug).join(', ') || '(none)';
          throw new Error(`No role "${role}". Available: ${available}`);
        }
        // Same walk-around `get_role_context` closes: a role file is a compiled
        // view of one workstream, so reading it through `ask` is reading that
        // workstream.
        assertInScope(await scope(teamctxDir, config), resolveTarget(found.workstream));
        roleMd = readRoleFile(role, teamctxDir);
      }
      const activeWorkstreamId = await targetWorkstream(teamctxDir, config, args.workstream);
      // The project has a tree of its own, and it is where a caller stands
      // unless they chose otherwise. Reading it as a workstream found nothing,
      // so a project full of context answered "there is nothing here yet".
      const workstream = readTree(activeWorkstreamId, teamctxDir);
      const contributions = readContributions(teamctxDir);
      const answer = await answerQuestion({
        sharedMd: readTreeMd(activeWorkstreamId, teamctxDir), roleMd, question, config,
        workstream, contributions, audit: !!audit,
        // A workstream answers with the project above it; the project answers
        // with itself, and passing it twice would repeat every Why.
        project: isProjectLevel(activeWorkstreamId) ? null : readProject(teamctxDir),
      });
      return textResult(answer);
    },

    async suggest_roles({ workstream } = {}) {
      const teamctxDir = dir();
      const result = await coreSuggestRoles({
        workstreamId: await targetWorkstream(teamctxDir, readConfig(teamctxDir), workstream),
        teamctxDir, projectDir: gitCwd,
      });
      return textResult(result);
    },

    async suggest_workstream_splits() {
      const teamctxDir = dir();
      const result = await suggestWorkstreamSplits({
        workstreamId: await targetWorkstream(teamctxDir, readConfig(teamctxDir), undefined),
        teamctxDir, projectDir: gitCwd,
      });
      return textResult({
        activeId: result.activeId,
        splits: result.splits,
        leftover: result.leftover,
      });
    },

    async contribute(args) {
      const teamctxDir = dir();
      const r = await contributeCore({
        text: args.text,
        author: args.author,
        workstreamId: await targetWorkstream(teamctxDir, readConfig(teamctxDir), args.workstream),
        decision: !!args.decision,
        apply: !!args.apply,
        source: 'mcp',
        teamctxDir,
        projectDir: gitCwd,
      });
      return textResult({ ...r, reportBack: reportBackContribute(r) });
    },

    async submit_contribution(args) {
      // Deprecated alias for backward compat. The old submit_contribution wrote
      // immediately (no approval queue), so preserve that by defaulting apply:true.
      return this.contribute({ ...args, apply: true });
    },

    async init(args) {
      const r = await initProject({
        projectDir: gitCwd,
        project: args.project, me: args.me,
        provider: args.provider || 'anthropic',
        model: args.model,
        autoPush: args.autoPush !== false,
        deployUrl: args.deployUrl,
        githubRawBase: args.githubRawBase,
        managerEmail: args.managerEmail,
        source: 'mcp',
      });
      const reportBack = `Tell the user: teamctx initialized at ${r.projectDir} for project "${r.config.project}"` +
        (r.envVarPresent ? '' : ` — WARNING: ${r.envVarNeeded} is not set in the environment; ask/contribute/reflect will fail until it is.`) +
        (r.pushed ? '. Committed and pushed.' : '. Committed (no remote configured yet).');
      return textResult({
        projectDir: r.projectDir,
        config: r.config,
        gitignoreChanged: r.gitignoreChanged,
        envVarNeeded: r.envVarNeeded,
        envVarPresent: r.envVarPresent,
        pushed: r.pushed,
        reportBack,
      });
    },

    async role_add(args) {
      const teamctxDir = dir();
      const r = await addRoleFull({
        name: args.name,
        responsibilities: args.responsibilities,
        excludes: args.excludes,
        email: args.email,
        // A role is a compiled view of a workstream, so creating one on a
        // workstream the caller cannot read is that boundary in reverse.
        workstreamId: await targetWorkstream(teamctxDir, readConfig(teamctxDir), args.workstream),
        teamctxDir,
        projectDir: gitCwd,
      });
      const reportBack = `Tell the user: role "${r.slug}" created on ${targetLabel(r.workstreamId, readConfig(teamctxDir).project)}${r.pushed ? ' (committed and pushed)' : ' (committed)'}.`;
      return textResult({ ...r, reportBack });
    },

    async role_assign(args) {
      const teamctxDir = dir();
      // Checked rather than resolved: this argument is required, and routing it
      // through the default would turn a missing one into a silent assignment
      // to wherever the caller happens to be standing.
      if (args.workstream !== undefined) {
        assertInScope(await scope(teamctxDir, readConfig(teamctxDir)), resolveTarget(args.workstream));
      }
      const r = await assignRole({
        slug: args.slug, workstreamId: args.workstream,
        teamctxDir, projectDir: gitCwd,
      });
      const reportBack = r.changed
        ? `Tell the user: role "${r.slug}" moved to ${targetLabel(r.workstreamId, readConfig(teamctxDir).project)}; role file regenerated.`
        : `Tell the user: role "${r.slug}" was already on ${targetLabel(r.workstreamId, readConfig(teamctxDir).project)} — no change.`;
      return textResult({ ...r, reportBack });
    },

    async workstream_split(args) {
      const teamctxDir = dir();
      const config = readConfig(teamctxDir);
      const r = await splitWorkstreams({
        accepted: args.accepted,
        // Resolved here rather than from the caller's stored preference, which
        // can still name a workstream they have been scoped off since.
        workstreamId: await targetWorkstream(teamctxDir, config, undefined),
        teamctxDir, projectDir: gitCwd,
      });
      const summary = r.results.map(x => `"${x.splitName}" (${x.newId}, ${x.movedWhyCount} Whys${x.movedRoles.length ? `, moved roles ${x.movedRoles.join(',')}` : ''})`).join('; ');
      const reportBack = `Tell the user: split ${targetLabel(r.sourceId, config.project)} into ${r.results.length} new workstream${r.results.length === 1 ? '' : 's'}: ${summary}.`;
      return textResult({ ...r, reportBack });
    },

    async workstream_use({ id } = {}) {
      // Project level is always in scope: it is inherited, read-only background
      // that a scoped member needs in order to make sense of their own branch.
      if (!isProjectLevel(id)) assertInScope(await scope(dir(), readConfig(dir())), id);
      const r = await useWorkstream({ id, teamctxDir: dir(), projectDir: gitCwd });
      return textResult({
        ...r,
        reportBack: r.activeWorkstream
          ? `Tell the user: their active workstream is now "${r.activeWorkstream}". This is a personal setting — it does not change anyone else's.`
          : "Tell the user: they are working on the project itself now, not one part of it. This is a personal setting — it does not change anyone else's.",
      });
    },

    async review_approve({ id }) {
      // No caller-supplied identity: the gate reads the authenticated actor.
      const r = await approveReview({ id, teamctxDir: dir(), projectDir: gitCwd });
      const reportBack = `Tell the user: approved contribution ${r.id} by ${r.author} on ${targetLabel(r.workstream, readConfig(dir()).project)} (${r.operations.length} op${r.operations.length === 1 ? '' : 's'}${r.rolesRegenerated.length ? `, regenerated roles: ${r.rolesRegenerated.join(', ')}` : ''}${r.pushed ? ', pushed' : ''}).`;
      return textResult({ ...r, reportBack });
    },

    async review_reject({ id, reason }) {
      const r = await rejectReview({ id, reason, teamctxDir: dir(), projectDir: gitCwd });
      const reportBack = `Tell the user: rejected ${r.id}${r.reason ? ` (reason: ${r.reason})` : ''}${r.pushed ? ' — pushed' : ''}.`;
      return textResult({ ...r, reportBack });
    },

    async snapshot_create({ message } = {}) {
      const teamctxDir = dir();
      const allowed = await scope(teamctxDir, readConfig(teamctxDir));
      const r = await createSnapshot({ message, teamctxDir, projectDir: gitCwd });
      // Taking a snapshot is not gated, and the result carries every tree it
      // just collected — so handing it back whole let anyone read the project
      // sideways in one call.
      r.snapshot = visibleSnapshot(r.snapshot, allowed);
      const reportBack = `Tell the user: snapshot ${r.snapshot.id} created${r.snapshot.message ? ` (${r.snapshot.message})` : ''} — manager must approve via snapshot_approve for it to become current.`;
      return textResult({ ...r, reportBack });
    },

    async snapshot_approve({ id }) {
      const r = await approveSnapshot({ prefix: id, teamctxDir: dir(), projectDir: gitCwd });
      const reportBack = `Tell the user: snapshot ${r.id} approved by ${r.approvedBy} — it is now the current-approved snapshot.`;
      return textResult({ ...r, reportBack });
    },

    async snapshot_reject({ id, reason }) {
      const r = await rejectSnapshot({ prefix: id, reason, teamctxDir: dir(), projectDir: gitCwd });
      const reportBack = `Tell the user: snapshot ${r.id} rejected${r.reason ? ` (reason: ${r.reason})` : ''}.`;
      return textResult({ ...r, reportBack });
    },

    async reflect({ workstream } = {}) {
      const teamctxDir = dir();
      // Reflect rewrites a tree wholesale. Under `reviewPolicy: none` nothing
      // else stands between a scoped member and a workstream they cannot read.
      const r = await reflectWorkstream({
        workstreamId: await targetWorkstream(teamctxDir, readConfig(teamctxDir), workstream),
        teamctxDir, projectDir: gitCwd,
      });
      const reportBack = `Tell the user: reflected ${targetLabel(r.workstreamId, readConfig(teamctxDir).project)}${r.rolesRegenerated.length ? `; regenerated roles: ${r.rolesRegenerated.join(', ')}` : ''}${r.pushed ? '; pushed' : ''}.`;
      return textResult({ workstreamId: r.workstreamId, rolesRegenerated: r.rolesRegenerated, pushed: r.pushed, pushError: r.pushError, reportBack });
    },

    async repair_manager_gate() {
      const r = await repairManagerGate({ teamctxDir: dir(), projectDir: gitCwd });
      const c = await commitContext(`config: repair manager gate (via mcp)`,
        gitCwd ? { cwd: gitCwd } : undefined);
      return textResult({
        ...r, committed: c?.committed === true,
        reportBack: `Tell the user: the manager gate was ${r.from}, which nobody could match. `
          + `It is now ${r.to}, so they can approve again.`
          + (r.warning ? ` Also tell them: ${r.warning}` : ''),
      });
    },

    async set_review_policy({ policy }) {
      const r = await setReviewPolicy(policy, { teamctxDir: dir(), projectDir: gitCwd });
      let committed = false;
      if (r.from !== r.to) {
        const c = await commitContext(
          `config: review policy ${r.from} to ${r.to} by ${(await who(dir(), readConfig(dir()))).name} (via mcp)`,
          gitCwd ? { cwd: gitCwd } : undefined);
        committed = c?.committed === true;
      }
      const said = {
        all: 'every contribution now waits for the manager',
        additive: 'contributions that only add now land immediately; edits and deletes wait for the manager',
        none: 'contributions now land immediately, and any member can rewrite the shared context with reflect',
      }[r.to];
      const what = r.from === r.to
        ? `Review policy was already ${r.to} — nothing changed.`
        : `Review policy set to ${r.to}: ${said}.${committed ? ' Committed to the repo.' : ''}`;
      return textResult({ ...r, committed, reportBack: `Tell the user: ${what}` });
    },

    async config_set({ key, value }) {
      const r = await setConfig({ key, value, teamctxDir: dir(), projectDir: gitCwd });
      // Every other mutating tool commits; this one did not. A hosted write
      // lands in the session's in-memory copy of the repo, so without a commit
      // the request ended and the change was gone — while the tool still
      // reported success, which is the worst way for a write to fail.
      let committed = false;
      if (r.wroteRepo) {
        // Reported rather than assumed: writing the value already stored leaves
        // nothing to commit, and a caller told otherwise has a success it can
        // only disprove by reading back.
        const c = await commitContext(`config: ${r.key} by ${(await who(dir(), readConfig(dir()))).name} (via mcp)`,
          gitCwd ? { cwd: gitCwd } : undefined);
        committed = c?.committed === true;
      }
      const notes = r.notes.length ? ` Notes: ${r.notes.join(' | ')}` : '';
      // Clearing is not setting. A client that surfaces only reportBack would
      // otherwise tell the user their name was set to the very value they just
      // removed the override for.
      const what = r.cleared
        ? `config.${r.key} override cleared — it is derived again, currently ${JSON.stringify(r.value)}.`
        : `config.${r.key} set to ${JSON.stringify(r.value)}.`;
      // Whether it persisted belongs in the sentence a client reads out. The
      // tool description tells callers to report this verbatim, so a success
      // string that does not depend on the write is a false success said aloud.
      const landed = r.wroteRepo
        ? (committed ? ' Committed to the repo.' : ' Nothing was committed — the value was already stored.')
        : '';
      return textResult({ ...r, committed, reportBack: `Tell the user: ${what}${landed}${notes}` });
    },
  };
}

export function buildServer(projectRoot) {
  const handlers = makeHandlers(projectRoot);

  const server = new Server(
    { name: 'teamctx', version: '0.2.0' },
    // `instructions` reaches the model once, before any tool call. Without it a
    // host has the whole surface and no idea when to reach for any of it — see
    // mcp/instructions.js.
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = handlers[req.params.name];
    if (!handler) throw new Error(`Unknown tool: ${req.params.name}`);
    try {
      return await handler.call(handlers, req.params.arguments || {});
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  return server;
}

export async function startMcpServer({ projectDir } = {}) {
  const projectRoot = projectDir ? pathResolve(projectDir) : resolveProjectDir();
  const envLocalPath = join(projectRoot, '.env.local');
  if (existsSync(envLocalPath)) dotenv.config({ path: envLocalPath });

  const server = buildServer(projectRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
