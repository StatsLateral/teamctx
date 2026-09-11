import { describe, it, expect } from 'vitest';
import {
  MEMBERSHIP_MODELS, DEFAULT_MEMBERSHIP,
  membershipModel, isKnownMembership, describeMembership,
} from './membership-model.js';

describe('reading a membership model back', () => {
  it('accepts each of the three', () => {
    MEMBERSHIP_MODELS.forEach(m => expect(membershipModel(m)).toBe(m));
  });

  it('falls back to the narrowest for anything invented', () => {
    // These come out of a language model, so an invented one is not a
    // hypothetical. Falling back to the narrowest claims the least about how
    // somebody runs their team, and a manager who wanted more will say so.
    expect(membershipModel('owner')).toBe(DEFAULT_MEMBERSHIP);
    expect(membershipModel('Assigned-Tasks')).toBe(DEFAULT_MEMBERSHIP);
    expect(membershipModel(null)).toBe(DEFAULT_MEMBERSHIP);
    expect(membershipModel(undefined)).toBe(DEFAULT_MEMBERSHIP);
    expect(membershipModel(42)).toBe(DEFAULT_MEMBERSHIP);
  });

  it('is the narrowest of the three that it falls back to', () => {
    expect(DEFAULT_MEMBERSHIP).toBe('assigned-tasks');
  });

  it('trims, because a model will hand back padded strings', () => {
    expect(membershipModel('  named-role  ')).toBe('named-role');
  });
});

describe('telling a real model from an invented one', () => {
  it('says so without silently correcting it', () => {
    // `membershipModel` normalises; this reports. A caller that wants to tell
    // the manager "the AI suggested something I do not recognise" needs the
    // second, and would never see it through the first.
    expect(isKnownMembership('named-role')).toBe(true);
    expect(isKnownMembership('owner')).toBe(false);
    expect(isKnownMembership('')).toBe(false);
  });
});

describe('describing one to a manager', () => {
  it('uses words about people, not about the data model', () => {
    MEMBERSHIP_MODELS.forEach(m => {
      const text = describeMembership(m);
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/workstream-position|assigned-tasks|named-role/);
    });
  });

  it('describes the fallback for something unrecognised', () => {
    expect(describeMembership('nonsense')).toBe(describeMembership(DEFAULT_MEMBERSHIP));
  });
});
