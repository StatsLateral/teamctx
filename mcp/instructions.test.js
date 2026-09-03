import { describe, it, expect } from 'vitest';
import { INSTRUCTIONS } from './instructions.js';
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
    // totalWhys covers a manager seeding in the same turn *and* one returning
    // to a project left empty earlier.
    expect(INSTRUCTIONS).toMatch(/totalWhys/);
  });

  it('says to apply the first one rather than queue it', () => {
    // Queueing it means asking the manager to approve their own opening
    // message, with nothing yet to review it against.
    expect(INSTRUCTIONS).toMatch(/founding\s+contribution/i);
    expect(INSTRUCTIONS).toMatch(/apply: true/);
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
    expect(contribute).toMatch(/totalWhys/);
    expect(contribute).toMatch(/first contribution/i);
  });
});

describe('the tools an agent has to pick between first', () => {
  const describeOf = (name) => TOOLS.find(t => t.name === name)?.description || '';

  it.each(['get_status', 'list_tasks', 'contribute', 'task_add', 'task_compile', 'get_connect_url'])(
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
