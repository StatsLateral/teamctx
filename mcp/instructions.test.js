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
