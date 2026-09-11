import { describe, it, expect } from 'vitest';
import {
  PROJECT_LEVEL, LEGACY_MAIN, isProjectLevel, resolveTarget, targetLabel,
} from './project-level.js';

describe('recognising project level', () => {
  it('treats an absent target as the project', () => {
    // The default has to be the project, not a workstream. Every caller that
    // passes nothing is asking about the whole thing.
    expect(isProjectLevel(null)).toBe(true);
    expect(isProjectLevel(undefined)).toBe(true);
    expect(isProjectLevel('')).toBe(true);
  });

  it('still accepts "main", so old references keep resolving', () => {
    // Stored preferences, saved configs and anyone typing from memory. None of
    // those update themselves when the workstream stops existing.
    expect(isProjectLevel(LEGACY_MAIN)).toBe(true);
    expect(isProjectLevel(' main ')).toBe(true);
  });

  it('treats any other id as a workstream', () => {
    expect(isProjectLevel('engineering')).toBe(false);
    expect(isProjectLevel('mainline')).toBe(false);
    expect(isProjectLevel('MAIN')).toBe(false);
  });
});

describe('normalising a target', () => {
  it('collapses every project-level spelling to one value', () => {
    [null, undefined, '', 'main', '  main  '].forEach(v => {
      expect(resolveTarget(v)).toBe(PROJECT_LEVEL);
    });
  });

  it('trims a workstream id and leaves it alone', () => {
    expect(resolveTarget(' engineering ')).toBe('engineering');
  });
});

describe('naming it for a person', () => {
  it('uses the project name at project level', () => {
    expect(targetLabel(null, 'Ledger')).toBe('Ledger');
    expect(targetLabel('main', 'Ledger')).toBe('Ledger');
  });

  it('falls back to plain words when there is no name', () => {
    expect(targetLabel(null, '')).toBe('the project');
  });

  it('uses the id for a workstream', () => {
    expect(targetLabel('engineering', 'Ledger')).toBe('engineering');
  });
});
