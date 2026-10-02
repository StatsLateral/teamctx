# Governed Records Data Model (#117) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Why → What → How tree with a goal, why records, nested workstreams, tasks and typed governed records, end to end, with no migration.

**Architecture:** A new `src/model.js` owns the shapes (Ajv schemas), plain labels, activity/expiry, numbering and walking. `src/ops.js` is rewritten around seven operations. A new `src/brief.js` renders every brief from the project down a workstream's ancestor chain. Everything else (contribute, review, init, scope, MCP tools, the project page, prompts) is rewired to these three modules, and the Why/What/How code is deleted.

**Tech Stack:** Node ≥18 ES modules, Vitest, `@modelcontextprotocol/sdk`, Express (hosted), **Ajv 8** (new).

**Spec:** `docs/superpowers/specs/2026-10-02-governed-records-design.md` (issue #117)

## Global Constraints

- Clean break. No migration, no compatibility layer. A tree file containing `whys` raises `LegacyFormatError` with: `This project uses the old Why/What/How format. Run \`teamctx init\` again to start it in the new format.`
- Record types, exactly: `why`, `decision`, `assumption`, `rule`, `exception`, `question`, `risk`.
- Record statuses, exactly: `active`, `replaced`, `broken`, `closed`. Expiry is computed at read time from `expiresAt` (ISO date `YYYY-MM-DD`, compared as strings against today's date).
- Required fields: assumption → `owner`, `reviewBy`; exception → `links.bends`, `expiresAt`; question → `owner`; risk → `owner`.
- Plain labels (verbatim): why `Why it matters:`; decision `We decided:`; assumption `We're assuming:`; rule `Rule:`; exception `Allowed:`; question `Open question:`; risk `Risk:`. Type names never appear in briefs or the UI.
- Operations, exactly: `setGoal`, `addRecord`, `editRecord`, `setRecordStatus`, `addTask`, `editTask`, `removeTask`. Applied in the order: setGoal → adds → edits → status changes → removals.
- `isAdditive`: `addTask`, and `addRecord` unless its type is `decision`, `rule` or `exception`. Everything else is not additive.
- Removed tools: `reflect`, `workstream_split`, `suggest_workstream_splits`. New tools: `list_records`, `get_record`, `workstream_add`.
- One new dependency only: `ajv` (MIT).
- Every commit signed off: `git commit -s`. Work on branch `feat/governed-records`. One PR for #117, reviewed by satyagyasingh.
- Suite green and `cli/loads.test.js` (`node --check` on every file) green at the end of every task.

### Spec deltas, flagged for the maintainer's review

1. **Structure lives in `config.workstreams`, not in each workstream file.** Each registry entry becomes `{ id, name, parent, order, createdAt }`. Workstream files hold `{ id, name, records, tasks }`. The reason: scope expansion ("on workstream 1 means also 1.2") then needs only `config`, which every caller already has. Reading every workstream file to answer a scope check would add a GitHub read per check on the hosted path. The spec's access boundary (one file per workstream) is unchanged.
2. **Founding fix (from the #116 review).** On a project with no context, a contribution from someone who `canApprove` applies **without** `apply: true`, because the manager's opening message has nobody else to review it. `get_connect_url` returns `joinable: false` with the same message `assertJoinableContext` would give, so the link and the gate agree.

## Review Focus

1. **A scoped member on a nested workstream:** a member on `1` must reach `1.2` and its tasks and records, and must never reach sibling `2` (or `2.1`) through `list_records`, `get_record`, `get_task`, `my_brief`, snapshots or the project page. Pinned in Task 5 and Task 10.
2. **An exception whose rule is out of the reader's scope, replaced, broken or expired:** the brief must not print the exception at all, rather than printing it alone. Pinned in Task 6.
3. **The AI proposes malformed operations** (unknown type, an exception without `bends`, an assumption without `reviewBy`, a `bends` pointing at a non-rule or a missing ID): these must be dropped with a reason recorded in the queue item, not written and not crashing the apply. Pinned in Task 3.
4. **Opening a project written in the old format:** every entry point (CLI, MCP, project page) must show the `LegacyFormatError` message, not an empty project or a stack trace. Pinned in Task 2 and Task 10.
5. **A cycle or a dangling parent in `workstream_add`** (parent is itself, a descendant, or unknown): this must be refused, and numbering must never loop. Pinned in Task 9.

---

## File structure

| File | Responsibility |
|---|---|
| `src/model.js` (new) | Ajv schemas; `RECORD_TYPES`, `LABELS`; `validateRecord`, `isActive`, `isExpired`; `emptyProject`, `emptyWorkstream`; `assertCurrentFormat`/`LegacyFormatError`; `workstreamTree`, `ancestorsOf`, `descendantsOf`, `numberWorkstreams`, `numberTasks` |
| `src/model.test.js` (new) | Model tests |
| `src/test-fixtures/model.js` (new) | `makeProject`, `makeWorkstream`, `makeRecord`, `makeTask`, `makeConfig`, used by every rewritten test |
| `src/ops.js` (rewrite) | `applyOps(tree, ops, contributionId) → { tree, dropped }`, `touchedBy(tree, contributionId)` |
| `src/brief.js` (new) | `renderBrief({ projectName, project, chain, contributions, today, includeSourceTags })` — the one Markdown renderer |
| `src/context.js` (rewrite of renderers/prompts) | `serializeToMd` becomes a thin wrapper over `renderBrief`; prompts reworded; reflection/split code removed |
| `src/ai.js` | `proposeDiff` prompt for the new operations; `modelForPrompt(tree)` |
| `src/storage.js` | New empty shapes; `assertCurrentFormat` on every tree read; legacy `main` handling removed |
| `src/member-scope.js` | `scopeFor` expands descendants via `config.workstreams` |
| `src/review-policy.js` | `isAdditive` for new operation types |
| `src/context-gate.js` | `hasContext` = goal, records or tasks |
| `src/tree-digest.js` | `digestProject` over the new model |
| `src/provenance.js` | Walk goal, records and tasks; `preserveSourcesThroughReflect` deleted |
| `src/recompile.js` | Recompile every workstream with its ancestor chain |
| `cli/commands/workstream.core.js` | `addWorkstream`; `listAllWorkstreams` with parent/number/counts; `proposeStructure` draft; split code deleted |
| `cli/commands/contribute.core.js`, `cli/commands/review.core.js`, `cli/commands/init.core.js` | Wire to the new ops, brief and founding rule |
| `cli/commands/records.core.js` (new) | `listRecords`, `getRecord` (scope-aware) |
| `mcp/server.js`, `mcp/instructions.js` | Tool table and handlers |
| `src/oauth/project-view.js`, `src/views/project.js` | Minimal outline on the new model (the full UI is #118) |
| Deleted | `src/migrate-project-layer.js`, `src/migrate.js`, `cli/commands/reflect*.js`, workstream split CLI and MCP paths, `LEGACY_MAIN` |

---

### Task 1: Model module, schemas and fixtures

**Files:**
- Create: `src/model.js`, `src/model.test.js`, `src/test-fixtures/model.js`
- Modify: `package.json` (add `"ajv": "^8.17.1"` to `dependencies`)

**Interfaces:**
- Produces:
  - `RECORD_TYPES: string[]`, `STATUSES: string[]`, `LABELS: Record<type,string>`
  - `validateRecord(record) → { ok: boolean, errors: string[] }`
  - `isExpired(record, today: 'YYYY-MM-DD') → boolean`
  - `isActive(record, today) → boolean`
  - `emptyProject(name) → { name, goal: null, records: [], tasks: [] }`
  - `emptyWorkstream(id, name) → { id, name, records: [], tasks: [] }`
  - `class LegacyFormatError extends Error` (code `LEGACY_FORMAT`)
  - `assertCurrentFormat(tree) → tree` (throws when `tree.whys` is present)
  - `workstreamTree(config) → Array<{ id, name, parent, order, children: [...] }>` (roots, sorted by `order` then `id`)
  - `ancestorsOf(config, id) → string[]` (root first, excluding `id`)
  - `descendantsOf(config, id) → string[]`
  - `numberWorkstreams(config) → Map<id, '1' | '1.2' | …>`
  - `numberTasks(tasks, prefix) → Map<taskId, '1.2.1' | …>`
  - `today() → 'YYYY-MM-DD'`
- Fixtures: `makeProject(over)`, `makeWorkstream(id, over)`, `makeRecord(over)`, `makeTask(over)`, `makeConfig(over)`

- [ ] **Step 1: Install Ajv**

Run: `npm install ajv@^8.17.1`
Expected: `package.json` `dependencies` gains `"ajv"`, and `package-lock.json` is updated.

- [ ] **Step 2: Write the failing tests** — `src/model.test.js`

```js
import { describe, it, expect } from 'vitest';
import {
  RECORD_TYPES, LABELS, validateRecord, isActive, isExpired,
  assertCurrentFormat, LegacyFormatError, workstreamTree, ancestorsOf,
  descendantsOf, numberWorkstreams, numberTasks, emptyProject,
} from './model.js';
import { makeRecord, makeConfig } from './test-fixtures/model.js';

describe('record types and labels', () => {
  it('has exactly the seven types, each with a plain label', () => {
    expect(RECORD_TYPES).toEqual(['why', 'decision', 'assumption', 'rule', 'exception', 'question', 'risk']);
    for (const t of RECORD_TYPES) expect(LABELS[t]).toMatch(/:$/);
    expect(LABELS.exception).toBe('Allowed:');
  });
});

describe('validateRecord', () => {
  it('accepts a minimal decision', () => {
    expect(validateRecord(makeRecord({ type: 'decision' })).ok).toBe(true);
  });
  it('requires owner and reviewBy on an assumption', () => {
    const r = validateRecord(makeRecord({ type: 'assumption', owner: null, reviewBy: undefined }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/owner/);
    expect(r.errors.join(' ')).toMatch(/reviewBy/);
  });
  it('requires bends and expiresAt on an exception', () => {
    const r = validateRecord(makeRecord({ type: 'exception', links: { bends: null }, expiresAt: undefined }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/bends/);
    expect(r.errors.join(' ')).toMatch(/expiresAt/);
  });
  it('rejects an unknown type and a malformed date', () => {
    expect(validateRecord(makeRecord({ type: 'fact' })).ok).toBe(false);
    expect(validateRecord(makeRecord({ type: 'assumption', owner: { key: 'k', name: 'n' }, reviewBy: 'next week' })).ok).toBe(false);
  });
});

describe('activity', () => {
  it('an exception past expiresAt is expired and not active', () => {
    const r = makeRecord({ type: 'exception', expiresAt: '2026-01-01', links: { bends: 'rec-r' } });
    expect(isExpired(r, '2026-01-02')).toBe(true);
    expect(isActive(r, '2026-01-02')).toBe(false);
    expect(isActive(r, '2026-01-01')).toBe(true);
  });
  it('replaced, broken and closed records are not active', () => {
    for (const status of ['replaced', 'broken', 'closed']) {
      expect(isActive(makeRecord({ status }), '2026-01-01')).toBe(false);
    }
  });
});

describe('format', () => {
  it('rejects the old Why/What/How shape with the exact message', () => {
    expect(() => assertCurrentFormat({ name: 'x', whys: [] })).toThrow(LegacyFormatError);
    expect(() => assertCurrentFormat({ name: 'x', whys: [] })).toThrow(/Run `teamctx init` again/);
  });
  it('accepts the new shape', () => {
    expect(assertCurrentFormat(emptyProject('p'))).toEqual(emptyProject('p'));
  });
});

describe('structure', () => {
  const config = makeConfig({ workstreams: [
    { id: 'sales', name: 'Sales', parent: null, order: 1 },
    { id: 'outreach', name: 'Outreach', parent: 'sales', order: 1 },
    { id: 'offer', name: 'Offer', parent: 'sales', order: 2 },
    { id: 'expansion', name: 'Expansion', parent: null, order: 2 },
  ] });
  it('builds roots in order with children', () => {
    const t = workstreamTree(config);
    expect(t.map(w => w.id)).toEqual(['sales', 'expansion']);
    expect(t[0].children.map(w => w.id)).toEqual(['outreach', 'offer']);
  });
  it('numbers nested workstreams', () => {
    const n = numberWorkstreams(config);
    expect(n.get('sales')).toBe('1');
    expect(n.get('offer')).toBe('1.2');
    expect(n.get('expansion')).toBe('2');
  });
  it('walks ancestors and descendants', () => {
    expect(ancestorsOf(config, 'offer')).toEqual(['sales']);
    expect(descendantsOf(config, 'sales').sort()).toEqual(['offer', 'outreach']);
    expect(descendantsOf(config, 'expansion')).toEqual([]);
  });
  it('numbers tasks after their workstream', () => {
    const n = numberTasks([{ id: 'a' }, { id: 'b' }], '1.2');
    expect(n.get('b')).toBe('1.2.2');
  });
  it('treats an unknown or self parent as a root instead of looping', () => {
    const bad = makeConfig({ workstreams: [
      { id: 'a', name: 'A', parent: 'a', order: 1 },
      { id: 'b', name: 'B', parent: 'ghost', order: 2 },
    ] });
    expect(workstreamTree(bad).map(w => w.id)).toEqual(['a', 'b']);
    expect(ancestorsOf(bad, 'a')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/model.test.js`
Expected: FAIL, `Cannot find module './model.js'`.

- [ ] **Step 4: Write the fixtures** — `src/test-fixtures/model.js`

```js
let n = 0;
const next = (p) => `${p}-${++n}`;

export function makeRecord(over = {}) {
  const type = over.type || 'decision';
  const base = {
    id: next('rec'), type, text: `${type} text`, detail: '', status: 'active',
    owner: ['assumption', 'question', 'risk'].includes(type) ? { key: 'git:owner@x', name: 'Owner' } : null,
    attachedTo: { kind: 'project' },
    links: { restsOn: [], bends: null, replaces: null, answers: null },
    sourceContributionIds: [], approvedBy: null,
    createdAt: '2026-10-01', updatedAt: '2026-10-01',
  };
  if (type === 'assumption') base.reviewBy = '2026-12-01';
  if (type === 'exception') { base.expiresAt = '2026-12-31'; base.links.bends = 'rec-rule'; }
  return { ...base, ...over, links: { ...base.links, ...(over.links || {}) } };
}

export function makeTask(over = {}) {
  return {
    id: next('task'), title: 'A task', owner: null, status: 'open',
    createdAt: '2026-10-01', doneAt: null, compiledAt: null, sourceContributionIds: [], ...over,
  };
}

export function makeProject(over = {}) {
  return { name: 'Project', goal: null, records: [], tasks: [], ...over };
}

export function makeWorkstream(id, over = {}) {
  return { id, name: id, records: [], tasks: [], ...over };
}

export function makeConfig(over = {}) {
  return {
    project: 'Project', me: 'Manager', managerKey: 'git:manager@x', reviewPolicy: 'all',
    members: [], roles: [], workstreams: [], ...over,
  };
}
```

- [ ] **Step 5: Implement** — `src/model.js`

```js
import Ajv from 'ajv';

export const RECORD_TYPES = ['why', 'decision', 'assumption', 'rule', 'exception', 'question', 'risk'];
export const STATUSES = ['active', 'replaced', 'broken', 'closed'];
export const LABELS = {
  why: 'Why it matters:', decision: 'We decided:', assumption: "We're assuming:",
  rule: 'Rule:', exception: 'Allowed:', question: 'Open question:', risk: 'Risk:',
};

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const PERSON = { type: 'object', required: ['name'], properties: { key: { type: ['string', 'null'] }, name: { type: 'string' } } };
const IDS = { type: 'array', items: { type: 'string' } };

const recordSchema = {
  type: 'object',
  required: ['id', 'type', 'text', 'status', 'attachedTo', 'links'],
  properties: {
    id: { type: 'string', minLength: 1 },
    type: { enum: RECORD_TYPES },
    text: { type: 'string', minLength: 1 },
    detail: { type: 'string' },
    status: { enum: STATUSES },
    owner: { anyOf: [PERSON, { type: 'null' }] },
    attachedTo: {
      type: 'object', required: ['kind'],
      properties: { kind: { enum: ['project', 'workstream', 'task'] }, id: { type: 'string' } },
    },
    reviewBy: DATE,
    expiresAt: DATE,
    links: {
      type: 'object',
      properties: {
        restsOn: IDS,
        bends: { type: ['string', 'null'] },
        replaces: { type: ['string', 'null'] },
        answers: { type: ['string', 'null'] },
      },
    },
    sourceContributionIds: IDS,
  },
  allOf: [
    { if: { properties: { type: { const: 'assumption' } } }, then: { required: ['owner', 'reviewBy'], properties: { owner: PERSON } } },
    { if: { properties: { type: { const: 'exception' } } }, then: { required: ['expiresAt'], properties: { links: { required: ['bends'], properties: { bends: { type: 'string', minLength: 1 } } } } } },
    { if: { properties: { type: { enum: ['question', 'risk'] } } }, then: { required: ['owner'], properties: { owner: PERSON } } },
  ],
};

const ajv = new Ajv({ allErrors: true });
const checkRecord = ajv.compile(recordSchema);

/** `{ ok, errors }`, where each error names the field, so a refusal can say what to fill in. */
export function validateRecord(record) {
  const ok = checkRecord(record);
  if (ok) return { ok: true, errors: [] };
  const errors = (checkRecord.errors || []).map(e => {
    const field = e.params?.missingProperty || e.instancePath.replace(/^\//, '').replace(/\//g, '.') || 'record';
    return `${field}: ${e.message}`;
  });
  return { ok: false, errors: [...new Set(errors)] };
}

export const today = () => new Date().toISOString().slice(0, 10);

export function isExpired(record, onDay = today()) {
  return !!record?.expiresAt && record.expiresAt < onDay;
}

export function isActive(record, onDay = today()) {
  return record?.status === 'active' && !isExpired(record, onDay);
}

export function emptyProject(name = '') {
  return { name, goal: null, records: [], tasks: [] };
}

export function emptyWorkstream(id, name = '') {
  return { id, name, records: [], tasks: [] };
}

export class LegacyFormatError extends Error {
  constructor() {
    super('This project uses the old Why/What/How format. Run `teamctx init` again to start it in the new format.');
    this.code = 'LEGACY_FORMAT';
  }
}

/** Every tree read passes through here, so the old shape is reported rather than read as empty. */
export function assertCurrentFormat(tree) {
  if (tree && Object.prototype.hasOwnProperty.call(tree, 'whys')) throw new LegacyFormatError();
  return tree;
}

// ---- Structure (config.workstreams is the registry) ----

function entries(config) {
  const list = (config?.workstreams || []).filter(w => w?.id);
  const ids = new Set(list.map(w => w.id));
  // A parent that is the entry itself or does not exist makes the entry a root:
  // a broken registry must still number and walk, never loop.
  return list.map(w => ({ ...w, parent: w.parent && w.parent !== w.id && ids.has(w.parent) ? w.parent : null }));
}

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id));

export function workstreamTree(config) {
  const list = entries(config);
  const build = (parent, seen) => list
    .filter(w => w.parent === parent && !seen.has(w.id))
    .sort(byOrder)
    .map(w => ({ id: w.id, name: w.name || w.id, parent: w.parent, order: w.order ?? 0, children: build(w.id, new Set([...seen, w.id])) }));
  return build(null, new Set());
}

export function ancestorsOf(config, id) {
  const list = entries(config);
  const out = [];
  let cur = list.find(w => w.id === id)?.parent || null;
  while (cur && !out.includes(cur) && cur !== id) {
    out.unshift(cur);
    cur = list.find(w => w.id === cur)?.parent || null;
  }
  return out;
}

export function descendantsOf(config, id) {
  const out = [];
  const walk = (nodes) => { for (const n of nodes) { out.push(n.id); walk(n.children); } };
  const find = (nodes) => { for (const n of nodes) { if (n.id === id) return n; const f = find(n.children); if (f) return f; } return null; };
  const node = find(workstreamTree(config));
  if (node) walk(node.children);
  return out;
}

export function numberWorkstreams(config) {
  const out = new Map();
  const walk = (nodes, prefix) => nodes.forEach((n, i) => {
    const num = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
    out.set(n.id, num);
    walk(n.children, num);
  });
  walk(workstreamTree(config), '');
  return out;
}

export function numberTasks(tasks, prefix) {
  const out = new Map();
  (tasks || []).forEach((t, i) => out.set(t.id, prefix ? `${prefix}.${i + 1}` : `${i + 1}`));
  return out;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/model.test.js`
Expected: PASS, all tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/model.js src/model.test.js src/test-fixtures/model.js
git commit -s -m "Model the governed records: types, schemas, expiry and structure"
```

---

### Task 2: Storage reads and writes the new shapes

**Files:**
- Modify: `src/storage.js` (`readProject`, `emptyProject`, `writeProject`, `readWorkstream`, `writeWorkstream`, `deleteWorkstream`, `listTasks`)
- Modify: `src/project-level.js` (remove `LEGACY_MAIN`)
- Delete: `src/migrate.js`, `src/migrate-project-layer.js`, their tests, and the `migrateIfNeeded` calls in `cli/index.js` and `mcp/server.js`
- Test: `src/storage.test.js` (rewrite the tree cases), plus a new `src/storage-format.test.js`

**Interfaces:**
- Consumes: `emptyProject`, `emptyWorkstream`, `assertCurrentFormat` from Task 1
- Produces: `readProject(dir) → { name, goal, records, tasks }`; `readWorkstream(id, dir) → { id, name, records, tasks }`; both throw `LegacyFormatError` on the old shape. `isProjectLevel(id)` is true only for `null`, `undefined` or `''`.

- [ ] **Step 1: Write the failing test** — `src/storage-format.test.js`

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readProject, readWorkstream, writeProject, writeWorkstream } from './storage.js';
import { LegacyFormatError } from './model.js';
import { isProjectLevel } from './project-level.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-')); mkdirSync(join(dir, 'workstreams')); });

describe('tree storage', () => {
  it('reads a missing project as the new empty shape', () => {
    expect(readProject(dir)).toEqual({ name: '', goal: null, records: [], tasks: [] });
  });
  it('round-trips a workstream', () => {
    writeWorkstream('sales', { id: 'sales', name: 'Sales', records: [], tasks: [] }, dir);
    expect(readWorkstream('sales', dir).name).toBe('Sales');
  });
  it('reports the old format instead of reading it as empty', () => {
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: 'p', whys: [] }));
    expect(() => readProject(dir)).toThrow(LegacyFormatError);
    writeFileSync(join(dir, 'workstreams', 'old.json'), JSON.stringify({ id: 'old', whys: [] }));
    expect(() => readWorkstream('old', dir)).toThrow(LegacyFormatError);
  });
  it('writes the project without a stray id', () => {
    writeProject({ id: 'x', name: 'p', goal: null, records: [], tasks: [] }, dir);
    expect(readProject(dir)).not.toHaveProperty('id');
  });
  it('no longer treats "main" as the project', () => {
    expect(isProjectLevel('main')).toBe(false);
    expect(isProjectLevel(null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/storage-format.test.js`
Expected: FAIL (`whys` is still the empty shape, and `isProjectLevel('main')` is true).

- [ ] **Step 3: Implement** — in `src/storage.js` replace the bodies:

```js
import { emptyProject as emptyProjectShape, emptyWorkstream, assertCurrentFormat } from './model.js';

export function readProject(dir) {
  const s = sessionRead(ctxPath('project.json'));
  if (s !== undefined) return s === null ? emptyProjectShape() : assertCurrentFormat(JSON.parse(s));
  const p = resolve(dir, 'project.json');
  if (!existsSync(p)) return emptyProjectShape();
  return assertCurrentFormat(JSON.parse(readFileSync(p, 'utf-8')));
}

export function writeProject(project, dir) {
  const { id, whys, ...rest } = project || {};
  const body = JSON.stringify({ ...emptyProjectShape(), ...rest }, null, 2);
  if (sessionWrite(ctxPath('project.json'), body)) return;
  writeFileSync(resolve(dir, 'project.json'), body);
}

export function readWorkstream(id, dir) {
  sanitizeWorkstreamId(id);
  const s = sessionRead(ctxPath('workstreams', `${id}.json`));
  if (s !== undefined) return s === null ? emptyWorkstream(id) : assertCurrentFormat(JSON.parse(s));
  const p = resolve(dir, 'workstreams', `${id}.json`);
  if (!existsSync(p)) return emptyWorkstream(id);
  return assertCurrentFormat(JSON.parse(readFileSync(p, 'utf-8')));
}
```

Delete the old `emptyProject()` helper. In `src/project-level.js`, delete `LEGACY_MAIN`, and make `isProjectLevel` return `id === null || id === undefined || id === ''`. Delete `src/migrate.js`, `src/migrate-project-layer.js` and their test files, and remove the `migrateIfNeeded` import and call from `cli/index.js` and `mcp/server.js`. In the `listTasks` comment, remove the `main` dedupe note (the dedupe itself can stay).

- [ ] **Step 4: Fix the storage tests**

Rewrite every case in `src/storage.test.js` that builds `{ whys: [...] }` to use `makeProject` / `makeWorkstream` from `src/test-fixtures/model.js`. Delete cases that assert on `main` aliasing.

Run: `npx vitest run src/storage.test.js src/storage-format.test.js src/project-level.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/storage.js src/storage*.test.js src/project-level*.js src/migrate*.js cli/index.js mcp/server.js
git commit -s -m "Store the project and workstreams in the new shape; report the old one"
```

---

### Task 3: Operations

**Files:**
- Rewrite: `src/ops.js`
- Rewrite: `src/ops.test.js`
- Modify: `src/review.js` (`applyQueueItem` returns the tree from `applyOps(...).tree`)

**Interfaces:**
- Consumes: `validateRecord`, `RECORD_TYPES` (Task 1)
- Produces:
  - `applyOps(tree, ops, contributionId, { actor, onDay }) → { tree, dropped: Array<{ op, reason }> }`
  - `touchedBy(tree, contributionId) → string[]` (goal → records → tasks, in that order; the goal reports as `'goal'`)
  - `OP_TYPES = ['setGoal','addRecord','editRecord','setRecordStatus','addTask','editTask','removeTask']`

- [ ] **Step 1: Write the failing tests** — `src/ops.test.js`

```js
import { describe, it, expect } from 'vitest';
import { applyOps, touchedBy, OP_TYPES } from './ops.js';
import { makeProject, makeRecord } from './test-fixtures/model.js';

const C = 'c-1';

describe('applyOps', () => {
  it('sets the goal and records provenance', () => {
    const { tree } = applyOps(makeProject(), [{ type: 'setGoal', text: 'Win 3 clients by Q4' }], C);
    expect(tree.goal).toMatchObject({ text: 'Win 3 clients by Q4', sourceContributionIds: [C] });
  });

  it('adds a record with a minted id and active status', () => {
    const { tree, dropped } = applyOps(makeProject(), [
      { type: 'addRecord', record: { type: 'decision', text: 'Fixed price', attachedTo: { kind: 'project' } } },
    ], C);
    expect(dropped).toEqual([]);
    expect(tree.records[0]).toMatchObject({ type: 'decision', status: 'active', sourceContributionIds: [C] });
    expect(tree.records[0].id).toMatch(/^rec-/);
  });

  it('lets an exception bend a rule added in the same contribution', () => {
    const { tree, dropped } = applyOps(makeProject(), [
      { type: 'addRecord', ref: 'r1', record: { type: 'rule', text: 'No nuts', attachedTo: { kind: 'project' } } },
      { type: 'addRecord', record: { type: 'exception', text: 'Adults cake may have frosting', expiresAt: '2026-12-31', links: { bends: 'r1' }, attachedTo: { kind: 'project' } } },
    ], C);
    expect(dropped).toEqual([]);
    const rule = tree.records.find(r => r.type === 'rule');
    expect(tree.records.find(r => r.type === 'exception').links.bends).toBe(rule.id);
  });

  it('drops malformed proposals with a reason instead of writing them', () => {
    const { tree, dropped } = applyOps(makeProject(), [
      { type: 'addRecord', record: { type: 'assumption', text: '20 guests', attachedTo: { kind: 'project' } } },
      { type: 'addRecord', record: { type: 'exception', text: 'x', expiresAt: '2026-12-31', links: { bends: 'rec-missing' }, attachedTo: { kind: 'project' } } },
      { type: 'addRecord', record: { type: 'fact', text: 'x', attachedTo: { kind: 'project' } } },
      { type: 'addWhy', text: 'old op' },
    ], C);
    expect(tree.records).toEqual([]);
    expect(dropped.map(d => d.reason).join(' | ')).toMatch(/owner|reviewBy/);
    expect(dropped.map(d => d.reason).join(' | ')).toMatch(/bends/);
    expect(dropped).toHaveLength(4);
  });

  it('refuses an exception that bends something other than a rule', () => {
    const dec = makeRecord({ id: 'rec-d', type: 'decision' });
    const { dropped } = applyOps(makeProject({ records: [dec] }), [
      { type: 'addRecord', record: { type: 'exception', text: 'x', expiresAt: '2026-12-31', links: { bends: 'rec-d' }, attachedTo: { kind: 'project' } } },
    ], C);
    expect(dropped[0].reason).toMatch(/must bend a rule/);
  });

  it('edits, changes status, and marks the older record replaced', () => {
    const old = makeRecord({ id: 'rec-old', type: 'decision', text: 'Old' });
    const { tree } = applyOps(makeProject({ records: [old] }), [
      { type: 'addRecord', record: { type: 'decision', text: 'New', links: { replaces: 'rec-old' }, attachedTo: { kind: 'project' } } },
      { type: 'editRecord', id: 'rec-old', changes: { detail: 'superseded' } },
    ], C);
    expect(tree.records.find(r => r.id === 'rec-old')).toMatchObject({ status: 'replaced', detail: 'superseded' });
  });

  it('sets status broken and closed', () => {
    const a = makeRecord({ id: 'rec-a', type: 'assumption' });
    const { tree } = applyOps(makeProject({ records: [a] }), [{ type: 'setRecordStatus', id: 'rec-a', status: 'broken' }], C);
    expect(tree.records[0].status).toBe('broken');
  });

  it('adds, edits and removes tasks', () => {
    let { tree } = applyOps(makeProject(), [{ type: 'addTask', title: 'Bake cake' }], C);
    const id = tree.tasks[0].id;
    ({ tree } = applyOps(tree, [{ type: 'editTask', id, title: 'Bake the cake' }], 'c-2'));
    expect(tree.tasks[0]).toMatchObject({ title: 'Bake the cake', status: 'open', owner: null });
    ({ tree } = applyOps(tree, [{ type: 'removeTask', id }], 'c-3'));
    expect(tree.tasks).toEqual([]);
  });

  it('applies in order setGoal → adds → edits → status → removals', () => {
    expect(OP_TYPES).toEqual(['setGoal', 'addRecord', 'editRecord', 'setRecordStatus', 'addTask', 'editTask', 'removeTask']);
  });
});

describe('touchedBy', () => {
  it('lists the goal, then records, then tasks this contribution wrote', () => {
    const { tree } = applyOps(makeProject(), [
      { type: 'addTask', title: 'T' },
      { type: 'setGoal', text: 'G' },
      { type: 'addRecord', record: { type: 'why', text: 'W', attachedTo: { kind: 'project' } } },
    ], C);
    const ids = touchedBy(tree, C);
    expect(ids[0]).toBe('goal');
    expect(ids[1]).toMatch(/^rec-/);
    expect(ids[2]).toBe(tree.tasks[0].id);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/ops.test.js`
Expected: FAIL (`OP_TYPES` is not exported, and `applyOps` returns a tree, not `{ tree, dropped }`).

- [ ] **Step 3: Implement** — replace `src/ops.js` entirely

```js
import { randomBytes } from 'crypto';
import { validateRecord, today } from './model.js';

export const OP_TYPES = ['setGoal', 'addRecord', 'editRecord', 'setRecordStatus', 'addTask', 'editTask', 'removeTask'];
const STATUS_TARGETS = ['replaced', 'broken', 'closed', 'active'];
const EDITABLE = ['text', 'detail', 'owner', 'reviewBy', 'expiresAt', 'links', 'attachedTo'];

const mint = (prefix) => `${prefix}-${randomBytes(4).toString('hex')}`;
const withSource = (item, c) => ({
  ...item,
  sourceContributionIds: [...new Set([...(item.sourceContributionIds || []), c])],
});

function addRecord(tree, op, c, refs, dropped, onDay) {
  const p = op.record || {};
  const links = { restsOn: [], bends: null, replaces: null, answers: null, ...(p.links || {}) };
  // A link may name another record proposed in this same contribution by its `ref`.
  for (const k of ['bends', 'replaces', 'answers']) if (links[k] && refs.has(links[k])) links[k] = refs.get(links[k]);
  links.restsOn = (links.restsOn || []).map(id => refs.get(id) || id);
  const record = {
    id: mint('rec'), type: p.type, text: String(p.text ?? '').trim(), detail: String(p.detail ?? ''),
    status: 'active', owner: p.owner ?? null, attachedTo: p.attachedTo || { kind: 'project' },
    ...(p.reviewBy ? { reviewBy: p.reviewBy } : {}), ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
    links, sourceContributionIds: [c], approvedBy: null, createdAt: onDay, updatedAt: onDay,
  };
  const v = validateRecord(record);
  if (!v.ok) { dropped.push({ op, reason: v.errors.join('; ') }); return tree; }
  if (record.type === 'exception') {
    const target = tree.records.find(r => r.id === record.links.bends);
    if (!target) { dropped.push({ op, reason: `links.bends: no record "${record.links.bends}"` }); return tree; }
    if (target.type !== 'rule') { dropped.push({ op, reason: 'an exception must bend a rule' }); return tree; }
  }
  if (op.ref) refs.set(op.ref, record.id);
  let records = [...tree.records, record];
  if (record.links.replaces) {
    records = records.map(r => r.id === record.links.replaces ? { ...withSource(r, c), status: 'replaced', updatedAt: onDay } : r);
  }
  return { ...tree, records };
}

function editRecord(tree, op, c, dropped, onDay) {
  const i = tree.records.findIndex(r => r.id === op.id);
  if (i === -1) { dropped.push({ op, reason: `no record "${op.id}"` }); return tree; }
  const changes = Object.fromEntries(Object.entries(op.changes || {}).filter(([k]) => EDITABLE.includes(k)));
  const next = { ...withSource(tree.records[i], c), ...changes, updatedAt: onDay };
  if (changes.links) next.links = { ...tree.records[i].links, ...changes.links };
  const v = validateRecord(next);
  if (!v.ok) { dropped.push({ op, reason: v.errors.join('; ') }); return tree; }
  return { ...tree, records: tree.records.map((r, j) => j === i ? next : r) };
}

function setStatus(tree, op, c, dropped, onDay) {
  if (!STATUS_TARGETS.includes(op.status)) { dropped.push({ op, reason: `unknown status "${op.status}"` }); return tree; }
  if (!tree.records.some(r => r.id === op.id)) { dropped.push({ op, reason: `no record "${op.id}"` }); return tree; }
  return { ...tree, records: tree.records.map(r => r.id === op.id ? { ...withSource(r, c), status: op.status, updatedAt: onDay } : r) };
}

export function applyOps(tree, ops, contributionId, { onDay = today() } = {}) {
  const dropped = [];
  const refs = new Map();
  let next = { ...tree, records: [...(tree.records || [])], tasks: [...(tree.tasks || [])] };
  const of = (t) => (ops || []).filter(o => o?.type === t);
  for (const o of (ops || [])) if (!OP_TYPES.includes(o?.type)) dropped.push({ op: o, reason: `unknown operation "${o?.type}"` });

  for (const o of of('setGoal')) {
    const text = String(o.text ?? '').trim();
    if (!text) { dropped.push({ op: o, reason: 'goal text is empty' }); continue; }
    next = { ...next, goal: withSource({ ...(next.goal || {}), text, updatedAt: onDay }, contributionId) };
  }
  for (const o of of('addRecord')) next = addRecord(next, o, contributionId, refs, dropped, onDay);
  for (const o of of('addTask')) {
    const title = String(o.title ?? '').trim();
    if (!title) { dropped.push({ op: o, reason: 'task title is empty' }); continue; }
    next = { ...next, tasks: [...next.tasks, {
      id: mint('task'), title, owner: o.owner ?? null, status: 'open', createdAt: onDay,
      doneAt: null, compiledAt: null, sourceContributionIds: [contributionId],
    }] };
  }
  for (const o of of('editRecord')) next = editRecord(next, o, contributionId, dropped, onDay);
  for (const o of of('editTask')) {
    if (!next.tasks.some(t => t.id === o.id)) { dropped.push({ op: o, reason: `no task "${o.id}"` }); continue; }
    next = { ...next, tasks: next.tasks.map(t => t.id === o.id ? { ...withSource(t, contributionId), title: String(o.title ?? t.title) } : t) };
  }
  for (const o of of('setRecordStatus')) next = setStatus(next, o, contributionId, dropped, onDay);
  for (const o of of('removeTask')) {
    if (!next.tasks.some(t => t.id === o.id)) { dropped.push({ op: o, reason: `no task "${o.id}"` }); continue; }
    next = { ...next, tasks: next.tasks.filter(t => t.id !== o.id) };
  }
  return { tree: next, dropped };
}

export function touchedBy(tree, contributionId) {
  const hit = (x) => (x?.sourceContributionIds || []).includes(contributionId);
  return [
    ...(hit(tree?.goal) ? ['goal'] : []),
    ...(tree?.records || []).filter(hit).map(r => r.id),
    ...(tree?.tasks || []).filter(hit).map(t => t.id),
  ];
}
```

- [ ] **Step 4: Update `src/review.js`**

```js
import { applyOps } from './ops.js';
export function applyQueueItem(tree, item) {
  return applyOps(tree, item.operations || [], item.id).tree;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/ops.test.js src/review.test.js`
Expected: PASS. (`src/review.test.js` cases that used Why/What/How operations are rewritten with `setGoal` / `addRecord` in this step.)

- [ ] **Step 6: Commit**

```bash
git add src/ops.js src/ops.test.js src/review.js src/review.test.js
git commit -s -m "Seven operations over goal, records and tasks; drop malformed proposals with a reason"
```

---

### Task 4: Review policy

**Files:**
- Modify: `src/review-policy.js` (`isAdditive`)
- Test: `src/review-policy.test.js`

**Interfaces:**
- Produces: `isAdditive(operations) → boolean`, following Global Constraints.

- [ ] **Step 1: Write the failing test** — add to `src/review-policy.test.js` (replacing the `addWhy`/`addWhat`/`addHow` cases)

```js
import { isAdditive, needsReview } from './review-policy.js';

describe('isAdditive on the governed model', () => {
  const rec = (type) => ({ type: 'addRecord', record: { type } });
  it('tasks and low-stakes records are additive', () => {
    expect(isAdditive([{ type: 'addTask', title: 't' }, rec('why'), rec('assumption'), rec('question'), rec('risk')])).toBe(true);
  });
  it('decisions, rules and exceptions never are', () => {
    for (const t of ['decision', 'rule', 'exception']) expect(isAdditive([rec(t)])).toBe(false);
  });
  it('edits, status changes, removals and the goal never are', () => {
    for (const type of ['editRecord', 'setRecordStatus', 'removeTask', 'editTask', 'setGoal']) {
      expect(isAdditive([{ type }])).toBe(false);
    }
  });
  it('additive policy still queues a decision', () => {
    expect(needsReview({ reviewPolicy: 'additive' }, [rec('decision')])).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/review-policy.test.js`
Expected: FAIL (the old `ADDITIVE_OPS` set).

- [ ] **Step 3: Implement** — in `src/review-policy.js` replace `ADDITIVE_OPS` and `isAdditive`

```js
const NEVER_ADDITIVE_RECORDS = new Set(['decision', 'rule', 'exception']);

function opIsAdditive(op) {
  if (op?.type === 'addTask') return true;
  if (op?.type === 'addRecord') return !NEVER_ADDITIVE_RECORDS.has(op.record?.type);
  return false;
}

export function isAdditive(operations) {
  const ops = operations || [];
  if (ops.length === 0) return true;
  return ops.every(opIsAdditive);
}
```

Remove `reflectNeedsManager` and its tests (`reflect` is deleted in Task 9).

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/review-policy.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review-policy.js src/review-policy.test.js
git commit -s -m "Decisions, rules and exceptions always need the manager, even under additive"
```

---

### Task 5: Scope carries down nested workstreams

**Files:**
- Modify: `src/member-scope.js` (`scopeFor`, `defaultWorkstream`)
- Test: `src/member-scope.test.js`

**Interfaces:**
- Consumes: `descendantsOf` (Task 1)
- Produces: `scopeFor(config, actor, { isManager }) → string[] | null`, which includes the descendants of every listed workstream. `inScope` and `assertInScope` are unchanged and work on the expanded list.

- [ ] **Step 1: Write the failing test**

```js
import { scopeFor, inScope } from './member-scope.js';
import { makeConfig } from './test-fixtures/model.js';

describe('nested scope', () => {
  const config = makeConfig({
    workstreams: [
      { id: 'sales', name: 'Sales', parent: null, order: 1 },
      { id: 'outreach', name: 'Outreach', parent: 'sales', order: 1 },
      { id: 'expansion', name: 'Expansion', parent: null, order: 2 },
      { id: 'renewals', name: 'Renewals', parent: 'expansion', order: 1 },
    ],
    members: [{ key: 'git:m@x', email: 'm@x', name: 'M', workstreams: ['sales'] }],
  });
  const actor = { key: 'git:m@x', email: 'm@x' };

  it('reaches every workstream below the one they are on', () => {
    const scope = scopeFor(config, actor);
    expect(inScope(scope, 'outreach')).toBe(true);
  });
  it('never reaches a sibling or its children', () => {
    const scope = scopeFor(config, actor);
    expect(inScope(scope, 'expansion')).toBe(false);
    expect(inScope(scope, 'renewals')).toBe(false);
  });
  it('a manager is unscoped', () => {
    expect(scopeFor(config, actor, { isManager: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/member-scope.test.js`
Expected: FAIL on `outreach`.

- [ ] **Step 3: Implement** — in `src/member-scope.js`

```js
import { descendantsOf } from './model.js';

export function scopeFor(config, actor, { isManager = false } = {}) {
  if (isManager) return null;
  const listed = memberWorkstreams(rosterEntry(config, actor));
  if (!listed) return null;
  return [...new Set(listed.flatMap(id => [id, ...descendantsOf(config, id)]))];
}
```

`defaultWorkstream` is unchanged: `scope[0]` is still the first listed workstream, because the expansion appends descendants after it.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/member-scope.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/member-scope.js src/member-scope.test.js
git commit -s -m "A member on a workstream reaches the parts below it, never its siblings"
```

---

### Task 6: One brief renderer

**Files:**
- Create: `src/brief.js`, `src/brief.test.js`
- Modify: `src/context.js` (`serializeToMd` becomes a wrapper; `renderTree` and `decisionMarker` deleted)
- Modify: `src/recompile.js`

**Interfaces:**
- Consumes: `LABELS`, `isActive`, `today` (Task 1)
- Produces:
  - `renderBrief({ projectName, project, chain, contributions = [], onDay = today(), includeSourceTags = false, lastUpdatedBy = '' }) → string`, where `chain` is the ancestor workstreams then the target, each `{ id, name, records, tasks, number }`. An empty `chain` renders the project alone.
  - `serializeToMd(tree, name, lastUpdatedBy, contributions, { includeSourceTags, includeContributors, chain, project }) → string`. This is a compatibility wrapper for existing callers; `chain` defaults to `[tree]` for a workstream, `[]` for the project.
  - `recompileInheritors({ project, config, contributions, teamctxDir }) → string[]`, which rewrites every workstream's Markdown with its full ancestor chain.

- [ ] **Step 1: Write the failing tests** — `src/brief.test.js`

```js
import { describe, it, expect } from 'vitest';
import { renderBrief } from './brief.js';
import { makeProject, makeWorkstream, makeRecord, makeTask } from './test-fixtures/model.js';

const ON = '2026-10-02';
const rule = makeRecord({ id: 'rec-rule', type: 'rule', text: 'No nuts anywhere' });
const exc = makeRecord({ type: 'exception', text: 'Chocolate frosting on the adults cake', expiresAt: '2026-10-31', links: { bends: 'rec-rule' } });

describe('renderBrief', () => {
  it('prints the goal and plain labels, never type names', () => {
    const md = renderBrief({ projectName: 'Party', project: makeProject({ goal: { text: 'A relaxed party' }, records: [makeRecord({ type: 'why', text: 'Family first' })] }), chain: [], onDay: ON });
    expect(md).toContain('A relaxed party');
    expect(md).toContain('Why it matters: Family first');
    expect(md).not.toMatch(/\b(decision|assumption|exception|rule|question|risk)\b:/);
  });

  it('prints an exception under the rule it bends, and nowhere else', () => {
    const md = renderBrief({ projectName: 'P', project: makeProject({ records: [rule, exc] }), chain: [], onDay: ON });
    const ruleAt = md.indexOf('Rule: No nuts anywhere');
    const excAt = md.indexOf('Allowed: Chocolate frosting');
    expect(ruleAt).toBeGreaterThan(-1);
    expect(excAt).toBeGreaterThan(ruleAt);
    expect(md.split('Allowed: Chocolate frosting')).toHaveLength(2);
    expect(md).toContain('until 2026-10-31');
  });

  it('omits an exception whose rule is not in the brief, replaced, or expired', () => {
    const orphan = renderBrief({ projectName: 'P', project: makeProject({ records: [exc] }), chain: [], onDay: ON });
    expect(orphan).not.toContain('Chocolate frosting');
    const replacedRule = { ...rule, status: 'replaced' };
    expect(renderBrief({ projectName: 'P', project: makeProject({ records: [replacedRule, exc] }), chain: [], onDay: ON })).not.toContain('Chocolate frosting');
    expect(renderBrief({ projectName: 'P', project: makeProject({ records: [rule, exc] }), chain: [], onDay: '2026-11-01' })).not.toContain('Chocolate frosting');
  });

  it('shows review dates and owners, and leaves out inactive records', () => {
    const md = renderBrief({ projectName: 'P', project: makeProject({ records: [
      makeRecord({ type: 'assumption', text: '20 guests', reviewBy: '2026-10-07', owner: { key: 'k', name: 'Maya' } }),
      makeRecord({ type: 'question', text: 'Invite daycare friends?', owner: { key: 'k', name: 'Maya' } }),
      makeRecord({ type: 'decision', text: 'Old cake', status: 'replaced' }),
    ] }), chain: [], onDay: ON });
    expect(md).toContain("We're assuming: 20 guests (check by 2026-10-07)");
    expect(md).toContain('Open question: Invite daycare friends? (Maya)');
    expect(md).not.toContain('Old cake');
  });

  it('walks the chain from the project down, labelling inherited parts', () => {
    const parent = makeWorkstream('food', { name: 'Food', number: '1', records: [makeRecord({ type: 'decision', text: 'Banana cake' })] });
    const child = makeWorkstream('cake', { name: 'Cake', number: '1.1', tasks: [makeTask({ title: 'Bake it', owner: 'Mum' })] });
    const md = renderBrief({ projectName: 'P', project: makeProject({ goal: { text: 'G' } }), chain: [parent, child], onDay: ON });
    expect(md.indexOf('G')).toBeLessThan(md.indexOf('1 Food'));
    expect(md.indexOf('1 Food')).toBeLessThan(md.indexOf('1.1 Cake'));
    expect(md).toContain('We decided: Banana cake');
    expect(md).toContain('1.1.1 Bake it — Mum');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/brief.test.js`
Expected: FAIL, `Cannot find module './brief.js'`.

- [ ] **Step 3: Implement** — `src/brief.js`

```js
import { LABELS, isActive, today, numberTasks } from './model.js';

const GROUPS = [
  ['why'],
  ['rule', 'decision', 'assumption'],
  ['question', 'risk'],
];

function line(r, tag) {
  const base = `${LABELS[r.type]} ${r.text}`;
  const extra = r.type === 'assumption' && r.reviewBy ? ` (check by ${r.reviewBy})`
    : (r.type === 'question' || r.type === 'risk') && r.owner?.name ? ` (${r.owner.name})` : '';
  const plan = r.type === 'risk' && r.detail ? ` — plan: ${r.detail}` : '';
  return `- ${base}${extra}${plan}${tag(r)}`;
}

function section(records, onDay, tag) {
  const active = (records || []).filter(r => isActive(r, onDay));
  const exceptionsOf = (ruleId) => active.filter(r => r.type === 'exception' && r.links?.bends === ruleId);
  const out = [];
  for (const types of GROUPS) {
    for (const r of active.filter(x => types.includes(x.type))) {
      out.push(line(r, tag));
      if (r.type === 'rule') {
        for (const e of exceptionsOf(r.id)) {
          const rule = active.find(x => x.id === e.links.bends);
          out.push(`  - ${LABELS.exception} ${e.text} (until ${e.expiresAt}, instead of: ${rule.text})${tag(e)}`);
        }
      }
    }
  }
  // Exceptions are only ever printed under their rule (above), so one whose rule
  // isn't active in this brief is dropped on purpose: an exception read without
  // its rule is a contradiction, not context.
  return out;
}

export function renderBrief({ projectName, project, chain = [], contributions = [], onDay = today(), includeSourceTags = false, lastUpdatedBy = '' }) {
  const tag = includeSourceTags ? (x) => (x.sourceContributionIds?.length ? `  [sources: ${x.sourceContributionIds.join(', ')}]` : '') : () => '';
  const by = lastUpdatedBy ? ` · Source: ${lastUpdatedBy} contribution` : '';
  const out = [`# Context — ${projectName}`, `*Last updated: ${onDay}${by}*`, ''];

  out.push('## Goal', project?.goal?.text ? `${project.goal.text}${tag(project.goal)}` : '*No goal yet.*', '');
  const projectLines = section(project?.records, onDay, tag);
  if (projectLines.length) out.push(...projectLines, '');
  for (const t of project?.tasks || []) out.push(`- Task: ${t.title}${t.owner ? ` — ${t.owner}` : ''}${t.status === 'done' ? ' (done)' : ''}`);

  chain.forEach((ws, i) => {
    const inherited = i < chain.length - 1;
    out.push(`## ${ws.number ? `${ws.number} ` : ''}${ws.name || ws.id}${inherited ? ' *(inherited — read-only here)*' : ''}`, '');
    const lines = section(ws.records, onDay, tag);
    if (lines.length) out.push(...lines, '');
    const nums = numberTasks(ws.tasks, ws.number);
    for (const t of ws.tasks || []) {
      out.push(`- ${nums.get(t.id)} ${t.title}${t.owner ? ` — ${t.owner}` : ''}${t.status === 'done' ? ' (done)' : ''}${tag(t)}`);
      for (const r of section((ws.records || []).filter(x => x.attachedTo?.kind === 'task' && x.attachedTo.id === t.id), onDay, tag)) out.push(`  ${r}`);
    }
    out.push('');
  });

  const empty = !project?.goal && !(project?.records || []).length && !chain.some(w => (w.records || []).length || (w.tasks || []).length);
  if (empty) out.push('*No context yet. Tell your assistant what the project is about to add the first contribution.*');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
```

Note for the implementer: `section(ws.records …)` at the workstream level must exclude records attached to a task, because those are printed under their task. Filter with `r.attachedTo?.kind !== 'task'` inside the workstream branch before calling `section`. Add the case "a record attached to a task prints once, under its task" to `src/brief.test.js` in this step.

- [ ] **Step 4: Rewire `src/context.js` and `src/recompile.js`**

In `src/context.js`, delete `decisionMarker`, `sourceTag` and `renderTree`, and replace `serializeToMd` with:

```js
import { renderBrief } from './brief.js';
import { collectContributorCounts, formatContributorsSection } from './provenance.js';

export function serializeToMd(tree, projectName, lastUpdatedBy = '', contributions = [], {
  includeSourceTags = false, includeContributors = true, project = null, chain = null,
} = {}) {
  const isProject = !tree?.id;
  const md = renderBrief({
    projectName,
    project: isProject ? tree : project,
    chain: chain ?? (isProject ? [] : [tree]),
    contributions, includeSourceTags, lastUpdatedBy,
  });
  if (includeSourceTags || !includeContributors) return md;
  const c = formatContributorsSection(collectContributorCounts(tree, contributions));
  return c ? `${md}\n${c}` : md;
}
```

Replace `src/recompile.js`:

```js
import { listWorkstreamIds, readWorkstream, writeWorkstreamMd } from './storage.js';
import { serializeToMd } from './context.js';
import { ancestorsOf, numberWorkstreams } from './model.js';

export function chainFor({ config, id, teamctxDir }) {
  const nums = numberWorkstreams(config);
  const named = (wid) => (config.workstreams || []).find(w => w.id === wid)?.name;
  return [...ancestorsOf(config, id), id].map(wid => {
    const ws = readWorkstream(wid, teamctxDir);
    return { ...ws, name: named(wid) || ws.name || wid, number: nums.get(wid) };
  });
}

export function recompileInheritors({ project, config, contributions = [], teamctxDir } = {}) {
  const ids = listWorkstreamIds(teamctxDir);
  for (const id of ids) {
    const chain = chainFor({ config, id, teamctxDir });
    const self = chain[chain.length - 1];
    writeWorkstreamMd(id, serializeToMd(self, self.name, '', contributions, { project, chain }), teamctxDir);
  }
  return ids;
}
```

A write to a workstream changes what its descendants inherit, so wherever `recompileInheritors` was called only for project-level writes (`contribute.core.js`, `review.core.js`), call it for every write.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/brief.test.js src/context.test.js src/recompile.test.js`
Expected: PASS, with the `src/context.test.js` and `src/recompile.test.js` assertions on `**Why:**` / `**What:**` text rewritten to the plain labels and `## <number> <name>` headings.

- [ ] **Step 6: Commit**

```bash
git add src/brief.js src/brief.test.js src/context.js src/context.test.js src/recompile.js src/recompile.test.js
git commit -s -m "One brief, from the project down: plain labels, exceptions under their rules"
```

---

### Task 7: The distiller proposes the new operations

**Files:**
- Modify: `src/ai.js` (`stripWorkstreamForPrompt` → `modelForPrompt`, `proposeDiff` prompt)
- Modify: `src/context.js` (`updateShared` returns `dropped`; `generateRoleFile` and `compileTaskPrompt` wording)
- Test: `src/ai.test.js`, `src/context.test.js`

**Interfaces:**
- Consumes: `applyOps` (Task 3)
- Produces:
  - `proposeDiff({ workstream, contribution, source, model, config, intent, avoid, today }) → { summary, operations }`. Operations follow the Global Constraints shapes: `{ type:'addRecord', ref?, record:{ type, text, detail?, owner?:{name}, reviewBy?, expiresAt?, links?, attachedTo } }`, `{ type:'setGoal', text }`, `{ type:'addTask', title }`, `{ type:'editRecord', id, changes }`, `{ type:'setRecordStatus', id, status }`, `{ type:'editTask', id, title }`, `{ type:'removeTask', id }`.
  - `updateShared(tree, contribution, config, opts) → { workstream, summary, operations, dropped }`

- [ ] **Step 1: Write the failing test** — in `src/ai.test.js` (the model call is already mocked in that file; reuse its `callClaude` mock)

```js
it('asks for governed operations and gives the current model ids and today', async () => {
  callClaude.mockResolvedValueOnce('{"summary":"s","operations":[]}');
  await proposeDiff({
    workstream: { id: 'food', name: 'Food', records: [{ id: 'rec-1', type: 'rule', text: 'No nuts', status: 'active' }], tasks: [] },
    contribution: 'Mum may use chocolate frosting on the adults cake until the party',
    source: 'Maya', config: {}, today: '2026-10-02',
  });
  const prompt = callClaude.mock.calls.at(-1)[0].prompt;
  expect(prompt).toContain('"addRecord"');
  expect(prompt).toContain('"exception"');
  expect(prompt).toContain('rec-1');
  expect(prompt).toContain('Today is 2026-10-02');
  expect(prompt).not.toMatch(/addWhy|addWhat|addHow|Why \/ What \/ How/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ai.test.js`
Expected: FAIL (the prompt still contains `addWhy`).

- [ ] **Step 3: Implement** — in `src/ai.js` replace `stripWorkstreamForPrompt` and the prompt body of `proposeDiff`

```js
function modelForPrompt(tree) {
  return {
    goal: tree.goal?.text ?? null,
    records: (tree.records || []).filter(r => r.status === 'active')
      .map(r => ({ id: r.id, type: r.type, text: r.text, ...(r.links?.bends ? { bends: r.links.bends } : {}) })),
    tasks: (tree.tasks || []).map(t => ({ id: t.id, title: t.title, status: t.status })),
  };
}
```

The prompt (system string becomes: `You turn a team contribution into typed, governed changes to a team's shared context. Output STRICT JSON only — no markdown fences, no commentary.`):

```js
const prompt = [
  `Part of the work: "${workstream.name || 'the project itself'}"`,
  `Today is ${onDay}.`,
  '',
  'Current context (ids you may reference):',
  JSON.stringify(modelForPrompt(workstream), null, 2),
  '',
  ...(avoid.length ? ['Already proposed earlier in this same import — do NOT restate these:', ...avoid.map(t => `- ${t}`), ''] : []),
  `${label} (source: ${source}):`,
  `"""${contribution}"""`,
  '',
  'Propose changes. Output STRICT JSON:',
  `{
  "summary": "1-2 sentences",
  "operations": [
    { "type": "setGoal", "text": "one line" },
    { "type": "addRecord", "ref": "optional local name", "record": {
        "type": "why|decision|assumption|rule|exception|question|risk",
        "text": "one plain sentence", "detail": "optional",
        "owner": { "name": "person" }, "reviewBy": "YYYY-MM-DD", "expiresAt": "YYYY-MM-DD",
        "links": { "bends": "<rule id or ref>", "replaces": "<id>", "restsOn": ["<id>"], "answers": "<question id>" },
        "attachedTo": { "kind": "project" } } },
    { "type": "editRecord", "id": "<existing id>", "changes": { "text": "..." } },
    { "type": "setRecordStatus", "id": "<existing id>", "status": "replaced|broken|closed" },
    { "type": "addTask", "title": "a concrete piece of work" },
    { "type": "editTask", "id": "<existing task id>", "title": "..." },
    { "type": "removeTask", "id": "<existing task id>" }
  ]
}`,
  '',
  'How to classify: why = the reason something matters; decision = something settled; assumption = believed but',
  'unproven (needs owner + reviewBy); rule = applies until changed; exception = an allowed deviation from ONE rule',
  '(needs links.bends naming that rule + expiresAt); question = open, needs owner; risk = could go wrong, needs owner',
  '(put the plan in detail). Concrete work is a task, not a record. Use the smallest set of operations; prefer',
  'editing or replacing over a near-duplicate. If the contribution contradicts an active record, add a question',
  'naming both instead of a second contradictory record. Dates are YYYY-MM-DD relative to today. JSON only.',
  ...(isDocument ? documentRules : []),
].join('\n');
```

Keep the existing document-intent lines as `documentRules`, reworded from "whys, decisions and constraints" to "decisions, rules, assumptions and reasons". `proposeDiff` takes `today: onDay = today()` from `src/model.js`.

In `src/context.js`, `updateShared` becomes:

```js
export async function updateShared(tree, contribution, config, { intent, avoid } = {}) {
  const { summary, operations } = await proposeDiff({ workstream: tree, contribution: contribution.text, source: contribution.author, model: config.model, config, intent, avoid });
  const { tree: updated, dropped } = applyOps(tree, operations, contribution.id);
  const kept = operations.filter(o => !dropped.some(d => d.op === o));
  return { workstream: updated, summary, operations: kept, dropped };
}
```

In `generateRoleFile` and `compileTaskPrompt`, replace `Why/What/How tree` with `shared context`, and replace the section instructions with: `## Your context` ("filter for this role; keep each line's plain label — 'We decided:', 'Rule:', 'Allowed:' and so on — exactly as written"), and `## Open questions and risks you own` ("None currently." if none). In `compileTaskPrompt`, the "Recent decisions" block becomes the active `decision` and `rule` records on the task's chain (exceptions under their rules), and the `tagged === 'decision'` filter is deleted.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ai.test.js src/context.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai.js src/ai.test.js src/context.js src/context.test.js
git commit -s -m "Distil contributions into governed records and tasks; drop what does not validate"
```

---

### Task 8: Contribute, review, init and the founding rule

**Files:**
- Modify: `cli/commands/contribute.core.js`, `cli/commands/review.core.js`, `cli/commands/init.core.js`, `src/context-gate.js`, `src/tree-digest.js`, `src/provenance.js`, `cli/commands/task.core.js` (`whysHash` → `contextHash`), `src/roles.js`, `cli/commands/role.core.js`, `cli/commands/status.js`
- Test: `cli/commands/contribute.core.test.js`, `cli/commands/contribute-policy.test.js`, `cli/commands/founding-contribution.test.js`, `src/context-gate.test.js`, `src/tree-digest.test.js`, `src/provenance.test.js`, `cli/commands/init*.test.js`

**Interfaces:**
- Consumes: Tasks 1–7
- Produces:
  - `contributeCore(...)` result adds `dropped: Array<{ reason }>` (reasons only, never the raw operation) and `touched` from `touchedBy`
  - `hasContext(tree) = !!tree.goal || tree.records.length > 0 || tree.tasks.length > 0`
  - `projectIsEmpty(teamctxDir)` uses `hasContext`
  - `digestProject({ project, workstreams }) → { goal, whys: string[], workstreams: [{ number, name, tasks: n, records: n }], counts: { [type]: n }, more }`
  - The founding rule: `mayApply = canApprove(...) && (apply || projectIsEmpty(teamctxDir))`

- [ ] **Step 1: Write the failing tests**

In `cli/commands/founding-contribution.test.js`, add:

```js
it("lands the manager's first contribution without apply:true, so the project is joinable", async () => {
  // fixture: empty project, caller is the manager, distiller mocked to return setGoal + a why
  const r = await contributeCore({ text: 'We are planning Leo\'s first birthday', teamctxDir, projectDir });
  expect(r.mode).toBe('applied');
  expect(() => assertJoinableContext({ config: readConfig(teamctxDir), teamctxDir })).not.toThrow();
});

it("still queues a member's first contribution to an empty project", async () => {
  // fixture: caller resolves to a non-manager member
  const r = await contributeCore({ text: 'hello', teamctxDir, projectDir });
  expect(r.mode).toBe('queued');
});
```

In `cli/commands/contribute.core.test.js`, add:

```js
it('reports what was dropped and why, and never writes it', async () => {
  proposeDiff.mockResolvedValueOnce({ summary: 's', operations: [
    { type: 'addRecord', record: { type: 'assumption', text: 'no owner', attachedTo: { kind: 'project' } } },
  ] });
  const r = await contributeCore({ text: 't', apply: true, teamctxDir, projectDir });
  expect(r.dropped[0].reason).toMatch(/owner/);
  expect(readProject(teamctxDir).records).toEqual([]);
});
```

In `src/context-gate.test.js`, a project with only a goal is joinable, and one with only tasks is joinable. In `src/tree-digest.test.js`, `digestProject` counts records by type and numbers workstreams.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run cli/commands/founding-contribution.test.js cli/commands/contribute.core.test.js src/context-gate.test.js src/tree-digest.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**
- `src/context-gate.js`: `const hasContext = (t) => !!t?.goal || (t?.records || []).length > 0 || (t?.tasks || []).length > 0;`
- `cli/commands/contribute.core.js`:
  - Compute `founding = projectIsEmpty(teamctxDir)` **before** `mayApply`, then `const mayApply = canApprove(config, { actor: resolved, displayName: resolvedName }) && (apply || founding); const applyRefused = apply && !mayApply;`.
  - Use `updateShared`'s `dropped`.
  - Replace `statementsTouchedBy` with `touchedBy`. The `viewUrl` built from it (#112) uses the first touched ID that isn't `'goal'` as `?item=`; when only the goal changed, it links to the project with no item.
  - Call `recompileInheritors` on every write, using `chainFor` for the target's own Markdown.
  - Put `dropped: dropped.map(d => ({ reason: d.reason }))` in every result.
  - Store `dropped` reasons on the queue item.
- `cli/commands/review.core.js`: the same `chainFor` / `recompileInheritors` wiring. `approveReview` records `approvedBy: { key, name, at }` on every record whose `sourceContributionIds` includes the item's ID.
- `cli/commands/init.core.js`: `const tree = emptyProject(project); writeProject(tree, teamctxDir); writeProjectMd(serializeToMd(tree, project), teamctxDir);`. Delete `workstreamsMigrated` and `projectLayerMigrated` from the new config, and the `migrate` imports.
- `src/tree-digest.js`: replace `digestTree` with `digestProject`, trimming each text to 160 characters. Include up to 8 whys and up to 12 workstreams, and set `more` when anything was cut. Update the founding read-back in `contribute.core.js` to use it.
- `src/provenance.js`: `walkNodes` walks `[tree.goal, ...tree.records, ...tree.tasks].filter(Boolean)`. Delete `collectExistingSourcesById`, `mergeIds` and `preserveSourcesThroughReflect`.
- `cli/commands/task.core.js`: `contextHash(chain)` hashes `JSON.stringify(chain.map(w => ({ id: w.id, records: w.records, tasks: (w.tasks||[]).map(t => t.title) })))`, so a compiled task is stale whenever its chain's records change.
- `src/roles.js` and `cli/commands/role.core.js`: the role-suggestion prompt lists `project.goal?.text`, why records and workstream names in place of `whys.map(...)`.
- `cli/commands/status.js`: print `Goal`, `Records` (by type) and `Tasks` in place of `Why nodes`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run cli/commands src/context-gate.test.js src/tree-digest.test.js src/provenance.test.js`
Expected: PASS, with every remaining `whys` fixture in these files rewritten to `src/test-fixtures/model.js`.

- [ ] **Step 5: Commit**

```bash
git add -A cli/commands src/context-gate* src/tree-digest* src/provenance* src/roles*
git commit -s -m "Contribute, review and init on the governed model; the manager's opening message lands"
```

---

### Task 9: Workstream structure tools; reflect and split removed

**Files:**
- Modify: `cli/commands/workstream.core.js`, `cli/commands/workstream.js`, `cli/index.js`
- Delete: `cli/commands/reflect.core.js`, `cli/commands/reflect.js`, their tests; `generateReflection`, `proposeSubworkstreams` and `normalizeSubworkstreamProposal` in `src/context.js`; `suggestWorkstreamSplits`, `applySplit` and `splitWorkstreams` and their tests
- Test: `cli/commands/workstream-add.test.js` (new), `cli/commands/propose-structure.test.js` (rewrite)

**Interfaces:**
- Produces:
  - `addWorkstream({ name, parent = null, teamctxDir, projectDir }) → { workstream: { id, name, parent, order, number }, pushed, pushError }`, manager-gated. Throws `WorkstreamParentError` (code `WORKSTREAM_PARENT`) when the parent is unknown, or would create a cycle.
  - `listAllWorkstreams(...) → Array<{ id, name, parent, number, isActive, recordCount, taskCount, roles }>`, in numbered order.
  - `proposeStructure(...) → { project, goal, whys: string[], workstreams: [{ name, parent, rationale, tasks: string[], records: [{ type, text }], membership }], questions: string[] }`. Read-only.

- [ ] **Step 1: Write the failing tests** — `cli/commands/workstream-add.test.js`

```js
it('adds a top-level and a nested workstream, numbered in order', async () => {
  const a = await addWorkstream({ name: 'Food & cake', teamctxDir, projectDir });
  const b = await addWorkstream({ name: 'Cake', parent: a.workstream.id, teamctxDir, projectDir });
  expect(a.workstream.number).toBe('1');
  expect(b.workstream.number).toBe('1.1');
  expect(readConfig(teamctxDir).workstreams.find(w => w.id === b.workstream.id).parent).toBe(a.workstream.id);
});

it('refuses an unknown parent', async () => {
  await expect(addWorkstream({ name: 'X', parent: 'ghost', teamctxDir, projectDir })).rejects.toThrow(/no workstream "ghost"/);
});

it('is the manager\'s alone', async () => {
  // fixture: caller resolves to a member
  await expect(addWorkstream({ name: 'X', teamctxDir, projectDir })).rejects.toMatchObject({ code: 'MANAGER_GATE' });
});
```

(The cycle case cannot be reached through `addWorkstream`, because a new ID can't be anyone's ancestor. It's covered at the model level in Task 1, "treats an unknown or self parent as a root".)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run cli/commands/workstream-add.test.js`
Expected: FAIL, `addWorkstream is not a function`.

- [ ] **Step 3: Implement** — in `cli/commands/workstream.core.js`

Imports this needs: `currentIdentity` and `assertManager` from `./review.core.js` (move `currentIdentity` into an export there if it's file-local), `slugify` from `../../src/roles.js`, `writeConfig`/`writeWorkstream` from `../../src/storage.js`, and `emptyWorkstream`/`numberWorkstreams` from `../../src/model.js`.

```js
export class WorkstreamParentError extends Error {
  constructor(parent) { super(`no workstream "${parent}" to put this under`); this.code = 'WORKSTREAM_PARENT'; }
}

export async function addWorkstream({ name, parent = null, teamctxDir, projectDir } = {}) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('a workstream needs a name');
  const config = readConfig(teamctxDir);
  const { actor, displayName } = await currentIdentity(config, teamctxDir, projectDir);
  assertManager(config, { actor, displayName });
  const list = config.workstreams || [];
  if (parent && !list.some(w => w.id === parent)) throw new WorkstreamParentError(parent);
  const base = slugify(clean) || 'workstream';
  let id = base; for (let i = 2; list.some(w => w.id === id); i++) id = `${base}-${i}`;
  const order = Math.max(0, ...list.filter(w => (w.parent || null) === (parent || null)).map(w => w.order || 0)) + 1;
  const entry = { id, name: clean, parent: parent || null, order, createdAt: new Date().toISOString() };
  const next = { ...config, workstreams: [...list, entry] };
  writeConfig(next, teamctxDir);
  writeWorkstream(id, emptyWorkstream(id, clean), teamctxDir);
  const git = await commitAndOptionallyPush(next, `workstream: add ${id}${parent ? ` under ${parent}` : ''}`, projectDir);
  return { workstream: { ...entry, number: numberWorkstreams(next).get(id) }, ...git };
}
```

`listAllWorkstreams` returns `parent`, `number` (from `numberWorkstreams`), `recordCount = ws.records.length` and `taskCount = ws.tasks.length`, sorted by number. `proposeStructure` sends the project goal, records and contributions to the AI with a prompt asking for the draft shape above, and returns it unapplied. Its tests mock `callClaude`, and assert the shape and that nothing was written (`readConfig` and the trees are unchanged). Delete the split and reflect code, CLI subcommands and tests, and remove `teamctx reflect` and `teamctx workstream split` from `cli/index.js`. Add `teamctx workstream add <name> [--under <id>]` to `cli/commands/workstream.js`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run cli/commands/workstream*.test.js cli/commands/propose-structure.test.js cli/loads.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A cli src/context.js
git commit -s -m "Add nested workstreams; remove reflect and the Why/What/How split tools"
```

---

### Task 10: MCP tools, records reads, and the project page

**Files:**
- Create: `cli/commands/records.core.js`, `cli/commands/records.core.test.js`
- Modify: `mcp/server.js` (tool table and handlers: `list_records`, `get_record`, `workstream_add`, `get_status`, `get_workstream`, `get_context`, `get_stats`, `get_connect_url`, `my_brief`; remove `reflect`, `workstream_split`, `suggest_workstream_splits`), `mcp/instructions.js`, `src/metrics.js`, `src/oauth/project-view.js`, `src/views/project.js`, `api/oauth-server.js` (LegacyFormatError → plain error page)
- Test: `mcp/hosted-isolation.test.js`, `mcp/records-tools.test.js` (new), `mcp/*.test.js` (fixtures), `api/project-view.test.js`

**Interfaces:**
- Produces:
  - `listRecords({ teamctxDir, scope, type, status, workstream, owner, due, onDay }) → Array<record & { workstream: id|null, number }>`. Active only unless `status` is given. `due: true` returns assumptions with `reviewBy <= onDay` plus exceptions expiring within 14 days.
  - `getRecord({ teamctxDir, scope, id }) → record & { workstream, number }`. Throws `RecordNotFoundError` (code `RECORD_NOT_FOUND`) both when the record is missing and when it's out of scope, so the answer leaks nothing.
  - `get_status` replaces `projectWhys`/`totalWhys` with `hasContext: boolean` and `counts: { records: {type:n}, tasks: n, workstreams: n }`.
  - `get_connect_url` adds `joinable: boolean` and `joinableReason: string|null`.

- [ ] **Step 1: Write the failing tests** — `mcp/records-tools.test.js` (build the server with the existing test harness used in `mcp/hosted-isolation.test.js`)

```js
it('list_records gives a scoped member their workstream and the parts below it, nothing else', async () => {
  // fixture: workstreams sales > outreach, expansion; a decision in each; member on 'sales'
  const r = JSON.parse((await call('list_records', {})).content[0].text);
  const ws = new Set(r.records.map(x => x.workstream));
  expect(ws.has('sales')).toBe(true);
  expect(ws.has('outreach')).toBe(true);
  expect(ws.has('expansion')).toBe(false);
});

it('get_record answers the same for out-of-scope and missing', async () => {
  const a = await call('get_record', { id: expansionDecisionId });
  const b = await call('get_record', { id: 'rec-nope' });
  expect(a.isError && b.isError).toBe(true);
  expect(a.content[0].text).toBe(b.content[0].text.replace('rec-nope', expansionDecisionId));
});

it('removed tools are gone', async () => {
  const names = (await listTools()).map(t => t.name);
  for (const n of ['reflect', 'workstream_split', 'suggest_workstream_splits']) expect(names).not.toContain(n);
  for (const n of ['list_records', 'get_record', 'workstream_add']) expect(names).toContain(n);
});

it('an old-format project answers with the re-init message, not an empty context', async () => {
  // fixture: project.json = { name: 'p', whys: [] }
  const r = await call('get_context', {});
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/Run `teamctx init` again/);
});

it('get_connect_url says the project is not joinable yet when it has no context', async () => {
  const r = JSON.parse((await call('get_connect_url', {})).content[0].text);
  expect(r.joinable).toBe(false);
  expect(r.joinableReason).toMatch(/nothing written down yet/);
});
```

In `mcp/hosted-isolation.test.js`, extend the scoped-member block with the nested case: a member on `sales` can `get_workstream('outreach')`, and can't `get_workstream('renewals')`.

In `api/project-view.test.js`, replace the Why/What/How rendering cases with:
- The page shows the goal and numbered workstreams.
- A scoped member's page data has no out-of-scope (including nested-sibling) workstream, records or tasks.
- An old-format repository shows the re-init message on a 4xx page.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run mcp/records-tools.test.js mcp/hosted-isolation.test.js api/project-view.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**
- `cli/commands/records.core.js`:

```js
import { readConfig, readProject, readWorkstream } from '../../src/storage.js';
import { isActive, numberWorkstreams, workstreamTree, today } from '../../src/model.js';
import { inScope } from '../../src/member-scope.js';

export class RecordNotFoundError extends Error {
  constructor(id) { super(`no record "${id}" on this project`); this.code = 'RECORD_NOT_FOUND'; }
}

function allTrees(teamctxDir, config, scope) {
  const flat = []; const walk = (ns) => ns.forEach(n => { flat.push(n.id); walk(n.children); });
  walk(workstreamTree(config));
  return [{ id: null, tree: readProject(teamctxDir) },
    ...flat.filter(id => inScope(scope, id)).map(id => ({ id, tree: readWorkstream(id, teamctxDir) }))];
}

export function listRecords({ teamctxDir, scope = null, type, status, workstream, owner, due, onDay = today() } = {}) {
  const config = readConfig(teamctxDir);
  const nums = numberWorkstreams(config);
  const soon = new Date(Date.parse(onDay) + 14 * 864e5).toISOString().slice(0, 10);
  return allTrees(teamctxDir, config, scope).flatMap(({ id, tree }) => (tree.records || [])
    .filter(r => (status ? r.status === status : isActive(r, onDay)))
    .filter(r => !type || r.type === type)
    .filter(r => workstream === undefined || id === workstream)
    .filter(r => !owner || r.owner?.name === owner || r.owner?.key === owner)
    .filter(r => !due || (r.type === 'assumption' && r.reviewBy <= onDay) || (r.type === 'exception' && r.expiresAt <= soon))
    .map(r => ({ ...r, workstream: id, number: id ? nums.get(id) : null })));
}

export function getRecord({ teamctxDir, scope = null, id } = {}) {
  const config = readConfig(teamctxDir);
  for (const { id: ws, tree } of allTrees(teamctxDir, config, scope)) {
    const r = (tree.records || []).find(x => x.id === id);
    if (r) return { ...r, workstream: ws, number: ws ? numberWorkstreams(config).get(ws) : null };
  }
  throw new RecordNotFoundError(id);
}
```

- `mcp/server.js`:
  - Add tool definitions. `list_records` (inputs: `type`, `status`, `workstream`, `owner`, `due`; description: "Rules, decisions, assumptions, exceptions, open questions, risks and reasons in your part of the project, in plain words; `due: true` lists assumptions to re-check and exceptions about to expire"). `get_record` (`id`). `workstream_add` (`RISKY`, manager-gated: `name`, `parent`).
  - Their handlers pass `scope: await scope(teamctxDir, config)`.
  - In `callTool`, wrap tool errors so that `LegacyFormatError` returns `{ isError: true, content: [{ type: 'text', text: e.message }] }`.
  - `get_status` gets the new counts. `get_connect_url` adds `joinable` / `joinableReason` by calling `assertJoinableContext` in a try/catch.
  - Delete the three removed tools from `TOOLS` and the handlers.
  - Replace every `totalWhys` mention in descriptions with `hasContext`.
- `mcp/instructions.js`: replace the Why/What/How vocabulary with "the goal, why it matters, decisions, rules (and allowed exceptions), assumptions, open questions, risks, and tasks". The founding step reads: "if `get_status` shows `hasContext: false`, the manager's first contribution lands on its own".
- `src/metrics.js`: count records and tasks wherever whys were counted.
- `src/oauth/project-view.js`:
  - Return `projectTree` (goal, records, tasks) and `trees` keyed by in-scope workstream ID (nested included through the expanded scope).
  - Add `structure: workstreamTree(config)` filtered to in-scope IDs, and `numbers` as a plain object.
  - Collect `contributionsBehind` over goal, records and tasks.
- `src/views/project.js`, a minimal outline until #118 replaces it:
  - The goal, then each in-scope workstream as `<h2>{number} {name}</h2>`.
  - Its records as `<li>{LABEL} {text}</li>`, with exceptions nested under rules via the same rule as `renderBrief`.
  - Its tasks as `<li>{number} {title} — {owner}</li>`.
  - Everything goes through `esc()`. Delete the columns/list/drawer code; #118 brings the full UI.
- `api/oauth-server.js`: in the `/project/:owner/:repo` catch, map `e.code === 'LEGACY_FORMAT'` to a 409 status with `errorPage(e.message)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run mcp api cli/commands/records.core.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A mcp api src/metrics* src/oauth/project-view* src/views/project.js cli/commands/records.core*
git commit -s -m "list_records, get_record and workstream_add; status, connect link and project page on the new model"
```

---

### Task 11: Full sweep, docs and changelog

**Files:**
- Modify: every remaining test file that fails or still references `whys`/`whats`/`hows`/`addWhy`/`reflect`
- Modify: `README.md` (model sections), `docs/mcp.md` (tool list), `CHANGELOG.md` (`## [Unreleased]`)

- [ ] **Step 1: Find what is left**

Run: `grep -rlnE "\bwhys\b|\bwhats\b|\bhows\b|addWhy|addWhat|addHow|editStatement|deleteStatement|reflect|LEGACY_MAIN|totalWhys" src cli mcp api README.md docs/mcp.md`
Expected: a list of files. Every hit is either rewritten to the new model or deleted with the feature it tested. Historical specs and plans under `docs/superpowers/` are left alone.

- [ ] **Step 2: Run the whole suite**

Run: `npm test`
Expected: PASS. Fix failures by rewriting fixtures to `src/test-fixtures/model.js`, never by deleting a behaviour test whose behaviour still exists.

- [ ] **Step 3: Docs**
- `README.md`: replace the Why/What/How explanation with the model diagram from the spec, the plain-label table, and one paragraph on governance ("decisions, rules and exceptions always need the manager").
- `docs/mcp.md`: add `list_records`, `get_record` and `workstream_add`; remove `reflect`, `workstream_split` and `suggest_workstream_splits`.
- `CHANGELOG.md` under `## [Unreleased]`, a **Breaking** entry: "The Why/What/How tree is replaced by a goal, why records, nested workstreams, tasks and governed records (decisions, assumptions, rules, exceptions, open questions, risks). No migration: re-run `teamctx init`. Removed: `reflect`, `workstream split`. Added: `list_records`, `get_record`, `workstream add`." Also a **Fixed** entry: "A manager's opening contribution lands without `apply: true`, so a new project can take members immediately."

- [ ] **Step 4: Verify everything loads**

Run: `npm test && node cli/index.js --help`
Expected: tests PASS; the help lists `workstream add` and no `reflect`.

- [ ] **Step 5: Commit and open the PR**

```bash
git add -A
git commit -s -m "Docs and changelog for the governed-records model"
git push -u origin feat/governed-records
gh pr create --title "Governed records: goal, nested workstreams, tasks and typed records (replaces Why/What/How)" --body "Closes #117. Spec: docs/superpowers/specs/2026-10-02-governed-records-design.md. Plan: docs/superpowers/plans/2026-10-02-governed-records-model.md. Spec deltas (structure in config.workstreams; founding fix) are listed at the top of the plan. Review requested: @satyagyasingh.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
