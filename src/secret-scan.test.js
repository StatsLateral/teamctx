/**
 * The secret scan over an upload's text (#252): recognisable keys and tokens
 * are found with their line and a redacted match, ordinary text is left alone,
 * and the generic rule is held back from low-entropy placeholders.
 */
import { describe, it, expect } from 'vitest';
import { scanForSecrets, redactSecret, entropyOf, describeSecretFindings } from './secret-scan.js';

describe('scanForSecrets — finds obvious secrets', () => {
  it('finds an AWS access key id with its line', () => {
    const f = scanForSecrets('line one\naws = AKIAIOSFODNN7EXAMPLE\n');
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe('aws-access-key-id');
    expect(f[0].line).toBe(2);
  });

  it('finds a PEM private key block', () => {
    const f = scanForSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----');
    expect(f.some(x => x.rule === 'private-key')).toBe(true);
  });

  it('finds GitHub, Slack, Google, Stripe and OpenAI tokens', () => {
    const rules = scanForSecrets([
      'gh = ghp_' + 'a'.repeat(36),
      'slack = xoxb-123456789012-abcdefABCDEF',
      'g = AIza' + 'B'.repeat(35),
      'stripe = sk_live_' + 'c'.repeat(24),
      'openai = sk-' + 'd'.repeat(20) + 'T3BlbkFJ' + 'e'.repeat(20),
    ].join('\n')).map(x => x.rule);
    expect(rules).toContain('github-token');
    expect(rules).toContain('slack-token');
    expect(rules).toContain('google-api-key');
    expect(rules).toContain('stripe-key');
    expect(rules).toContain('openai-key');
  });

  it('catches a high-entropy generic assignment', () => {
    const f = scanForSecrets('api_key = "f3Kd9zQ1mPx7Lw0aB4nR8sT2uV6yH5c"');
    expect(f.some(x => x.rule === 'generic-api-key')).toBe(true);
  });
});

describe('scanForSecrets — does not cry wolf', () => {
  it('passes ordinary prose and data', () => {
    expect(scanForSecrets('The quarterly plan is due Friday. Owner: Ana.')).toEqual([]);
    expect(scanForSecrets('a,b,c\n1,2,3\n4,5,6')).toEqual([]);
  });

  it('holds the generic rule back from a low-entropy placeholder', () => {
    expect(scanForSecrets('password = "changeme_changeme_change"')).toEqual([]);
    expect(scanForSecrets('token = "aaaaaaaaaaaaaaaaaaaaaaaa"')).toEqual([]);
  });

  it('does not match a keyword buried in a longer word with the value elsewhere', () => {
    // 'auth' sits inside 'author'/'oauth', but the generic rule anchors on
    // [:=] right after the keyword, so these ordinary lines are not flagged.
    expect(scanForSecrets('author = Christopher_Columbus_Expedition_1492_AD')).toEqual([]);
    expect(scanForSecrets('oauth_redirect_path = /some/long/callback/url/here/x')).toEqual([]);
  });

  it('does not flag an ordinary sk- identifier without the OpenAI marker', () => {
    expect(scanForSecrets('ref = sk-item-code-abcdefghijklmnopqrstuvwx')).toEqual([]);
  });

  it('reports a repeated key on one line once', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const f = scanForSecrets(`${key} and again ${key}`);
    expect(f).toHaveLength(1);
  });

  it('returns nothing for empty or non-string input', () => {
    expect(scanForSecrets('')).toEqual([]);
    expect(scanForSecrets(null)).toEqual([]);
    expect(scanForSecrets(undefined)).toEqual([]);
  });
});

describe('redaction and helpers', () => {
  it('never returns the whole secret', () => {
    const r = redactSecret('AKIAIOSFODNN7EXAMPLE');
    expect(r).not.toBe('AKIAIOSFODNN7EXAMPLE');
    expect(r).toContain('…');
    expect(r.startsWith('AKIA')).toBe(true);
  });

  it('masks a short value too', () => {
    expect(redactSecret('abc')).toBe('ab…');
  });

  it('entropyOf is higher for random than repeated text', () => {
    expect(entropyOf('f3Kd9zQ1mPx7Lw0aB4nR8sT2uV6yH5c')).toBeGreaterThan(entropyOf('aaaaaaaaaaaaaaaa'));
  });

  it('describes findings one per line with the redacted match', () => {
    const text = describeSecretFindings([{ rule: 'aws-access-key-id', line: 2, match: 'AKIA…LE' }]);
    expect(text).toContain('line 2');
    expect(text).toContain('aws-access-key-id');
    expect(text).toContain('AKIA…LE');
  });
});
