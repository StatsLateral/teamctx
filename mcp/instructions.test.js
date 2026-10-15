import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { INSTRUCTIONS, AGENT_INSTRUCTIONS } from './instructions.js';
import { TOOLS } from './server.js';

/**
 * The guidance is prose, so nothing else would notice it going stale. These
 * assert the two things it exists to do: name only tools that exist, and keep
 * teamctx's internal vocabulary out of what the agent says to a person.
 */

const named = [...INSTRUCTIONS.matchAll(/`([a-z_]+)`/g)].map(m => m[1]);
const toolNames = new Set(TOOLS.map(t => t.name));

describe('the instructions sent before any tool call', () => {
  it('names only tools that exist', () => {
    // A sequence pointing at a tool that was renamed is worse than no sequence:
    // the agent tries it, fails, and falls back to guessing.
    const invented = named.filter(n => !toolNames.has(n) && !['mine', 'true', 'compile'].includes(n));
    expect(invented, `not real tools: ${invented.join(', ')}`).toEqual([]);
  });

  it('gives both sequences, not just the manager one', () => {
    // The member path is the one that runs daily; the manager sets up once.
    expect(INSTRUCTIONS).toMatch(/list_tasks/);
    expect(INSTRUCTIONS).toMatch(/task_compile/);
    expect(INSTRUCTIONS).toMatch(/init/);
  });

  it('says a contribution queues rather than lands', () => {
    // The single most misreported outcome: an agent telling somebody their work
    // is in the project when it is waiting for review.
    expect(INSTRUCTIONS).toMatch(/queue/i);
  });

  it('tells the agent not to make the user learn the vocabulary', () => {
    // The actual failure from the walkthrough — it explained the data model to
    // someone who had never asked to learn it.
    expect(INSTRUCTIONS).toMatch(/workstream/);
    expect(INSTRUCTIONS).toMatch(/internal vocabulary|do not/i);
  });
});

describe('the founding contribution', () => {
  // A project's workstream starts empty and nothing pushes it out of that
  // state, so the context reads "No context yet" until somebody contributes.
  // The manager finishes setup and finds a project that knows nothing.
  it('names the condition, not "just after init"', () => {
    // hasContext covers a manager seeding in the same turn *and* one returning
    // to a project left empty earlier.
    expect(INSTRUCTIONS).toMatch(/hasContext: false/);
  });

  it('says the first one lands rather than queueing', () => {
    // Queueing it means asking the manager to approve their own opening
    // message, with nothing yet to review it against.
    expect(INSTRUCTIONS).toMatch(/founding\s+contribution/i);
    expect(INSTRUCTIONS).toMatch(/lands on its own|lands without being asked/i);
  });

  it('keeps the queue rule for everything after it', () => {
    // The carve-out must not read as "contributions land".
    expect(INSTRUCTIONS).toMatch(/sent for review/i);
    expect(INSTRUCTIONS).toMatch(/except the founding one/i);
  });

  it('says a refusal means the caller is not the manager', () => {
    // apply:true is gated. Without this an agent retries a permission error.
    expect(INSTRUCTIONS).toMatch(/not an error to retry|not actually the manager/i);
  });

  it('survives a client that ignores instructions', () => {
    // The trigger is a condition rather than a tool, so unlike the rest of this
    // file it has no natural tool-description half. contribute carries a short
    // version so the guidance degrades instead of disappearing.
    const contribute = TOOLS.find(t => t.name === 'contribute').description;
    expect(contribute).toMatch(/hasContext:false/);
    expect(contribute).toMatch(/first contribution/i);
  });
});

describe('the tools an agent has to pick between first', () => {
  const describeOf = (name) => TOOLS.find(t => t.name === name)?.description || '';

  it.each(['my_brief', 'get_status', 'list_tasks', 'contribute', 'task_add', 'task_compile', 'get_connect_url'])(
    '%s says when to reach for it, not only what it does',
    (name) => {
      // Tool descriptions are the half that still works in a client that
      // ignores `instructions`, so the sequencing has to survive there too.
      expect(describeOf(name)).toMatch(/reach for this|call this first|this is how/i);
    },
  );

  it('tells list_tasks not to ask the caller who they are', () => {
    expect(describeOf('list_tasks')).toMatch(/never ask/i);
  });

  it('tells contribute to report review, not arrival', () => {
    expect(describeOf('contribute')).toMatch(/sent for review/i);
  });
});

describe('the model the instructions describe', () => {
  it('is the governed one, not the old three-level tree', () => {
    expect(INSTRUCTIONS).not.toMatch(/three-level tree|why-tree|Why\/What\/How/i);
    expect(INSTRUCTIONS).toMatch(/decisions/);
    expect(INSTRUCTIONS).toMatch(/workstream_add/);
  });
});

describe('the labels the instructions teach', () => {
  it('are the four the MVP governs', () => {
    expect(INSTRUCTIONS).not.toMatch(/Open question:|Risk:/);
  });
});

describe('offering a decision as it is made', () => {
  // The rule exists to keep an assistant from sending what nobody agreed to
  // send, so these pin the consent half before the offering half.
  it('waits for a yes before calling contribute', () => {
    expect(INSTRUCTIONS).toMatch(/Wait for a yes/);
    expect(INSTRUCTIONS).toMatch(/Never call `contribute` for this without a yes/);
  });

  it('offers for decisions, rules and changed assumptions, not chat, brainstorming or tasks', () => {
    expect(INSTRUCTIONS).toMatch(/decision, a rule, or a\s+changed assumption/);
    expect(INSTRUCTIONS).toMatch(/Not for chat,\s+brainstorming, options still being weighed, or tasks/);
  });

  it('offers once per decision and treats a no as final', () => {
    expect(INSTRUCTIONS).toMatch(/One offer per decision/);
    expect(INSTRUCTIONS).toMatch(/a "no" is final/);
  });

  it('reads back what is sent', () => {
    expect(INSTRUCTIONS).toMatch(/read back to them first/);
  });

  it('is carried by contribute too, for a client that ignores instructions', () => {
    const contribute = TOOLS.find(t => t.name === 'contribute').description;
    expect(contribute).toMatch(/only after they say yes/);
    expect(contribute).toMatch(/a no is final/);
  });

  it('is not asked of an unattended agent, which has nobody to say yes', () => {
    expect(AGENT_INSTRUCTIONS).toMatch(/never send a decision you reached on your own/);
  });
});

describe('the bring-your-own-agent recipe for offering decisions', () => {
  const recipe = readFileSync(new URL('../recipes/offer-decisions.md', import.meta.url), 'utf-8');

  it('carries the same consent rule', () => {
    expect(recipe).toMatch(/Wait for my yes/);
    expect(recipe).toMatch(/Never send anything without a yes/);
    expect(recipe).toMatch(/Not for chat,\s+brainstorming/);
    expect(recipe).toMatch(/Offer once per decision/);
    expect(recipe).toMatch(/that\s+is final for that text/);
  });

  it('is listed in the recipes index and in each tool guide', () => {
    for (const f of ['README.md', 'claude-code/README.md', 'cursor/README.md', 'chatgpt/README.md']) {
      expect(readFileSync(new URL(`../recipes/${f}`, import.meta.url), 'utf-8'), f).toMatch(/offer-decisions\.md/);
    }
  });
});

describe('a member carrying on with earlier work', () => {
  it('is sent to the task\'s saved work before starting', () => {
    expect(INSTRUCTIONS).toMatch(/get_task/);
    expect(INSTRUCTIONS).toMatch(/start from\s+the latest, not\s+from the title/);
  });

  it('saves each round with task_output and submits only when asked', () => {
    expect(INSTRUCTIONS).toMatch(/task_output/);
    expect(INSTRUCTIONS).toMatch(/task_submit/);
    expect(INSTRUCTIONS).toMatch(/only when they ask/);
  });

  it('tells the assistant to start from the saved work in task_compile and my_brief too', () => {
    const of = (n) => TOOLS.find(t => t.name === n).description;
    expect(of('task_compile')).toMatch(/start from the latest/);
    expect(of('my_brief')).toMatch(/savedOutputs/);
  });
});
