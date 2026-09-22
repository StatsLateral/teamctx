import { describe, it, expect } from 'vitest';
import { recordedKey } from './recorded-key.js';

describe('the identity recorded against what somebody did', () => {
  it('is their verified address, however they signed in', () => {
    expect(recordedKey({ key: 'github:123818561', email: 'Satyagyasingh@Gmail.com', source: 'github' }))
      .toBe('git:satyagyasingh@gmail.com');
    expect(recordedKey({ key: 'git:maya@example.com', email: 'maya@example.com', source: 'google' }))
      .toBe('git:maya@example.com');
  });

  it('falls back to their own key when the sign-in revealed no address', () => {
    expect(recordedKey({ key: 'github:44', email: null })).toBe('github:44');
  });

  it('is nothing for nobody', () => {
    expect(recordedKey(null)).toBe(null);
  });
});
