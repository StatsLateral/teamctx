import { describe, it, expect } from 'vitest';
import { settingsPage } from './settings.js';

const user = { name: 'Satya', email: 'satya@example.com', login: 'satya', id: 1 };

describe('settings page — missing encryption key', () => {
  it('shows the administrator message when the key is not configured', () => {
    const html = settingsPage({ user, secretsMissing: true });
    expect(html).toContain('TEAMCTX_SECRET_KEYS');
    expect(html).toMatch(/administrator must set/i);
  });

  it('says nothing about it when a key is configured', () => {
    const html = settingsPage({ user, secretsMissing: false });
    expect(html).not.toContain('TEAMCTX_SECRET_KEYS');
  });
});
