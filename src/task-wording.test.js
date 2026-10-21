import { describe, it, expect } from 'vitest';
import { taskTitleProblem } from './task-wording.js';

describe('a proposed task a person picks up', () => {
  it('passes when it starts with what somebody does and names the thing', () => {
    for (const t of [
      'Write the launch post for article 1',
      'Book the venue for the March meetup',
      'Draft native posts for the launch',
      'Bring the banners to the venue',
      'Decide the ticket price',
      'Ask Maya for the speaker list',
    ]) expect(taskTitleProblem(t), t).toBeNull();
  });

  it('fails when it is addressed to an assistant', () => {
    for (const t of [
      'Use your web search to find three venues',
      'Ask Claude to rank the sources',
      'Have the AI summarise the brief',
      'Tell the assistant to draft the posts',
    ]) expect(taskTitleProblem(t), t).toMatch(/assistant/);
  });

  it('fails when it does not start with what a person does', () => {
    for (const t of ['The seven extracted content atoms', 'Drafting posts for the atoms', '3 posts for LinkedIn', 'We should post on Monday'])
      expect(taskTitleProblem(t), t).toMatch(/what a person does/);
  });

  it('fails when it does not name the thing', () => {
    for (const t of ['Review', 'Finish it', 'Do this', '', null]) expect(taskTitleProblem(t), String(t)).toMatch(/name the thing/);
  });
});
