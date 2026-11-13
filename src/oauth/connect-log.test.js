/**
 * Diagnosable connect logging (#285): a request id, one failure line, no secret.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { newRequestId, logConnectFailure, errorCodeOf } from './connect-log.js';

afterEach(() => vi.restoreAllMocks());

describe('newRequestId', () => {
  it('is a short req_ id, and different each time', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(/^req_[0-9a-f]{10}$/);
    expect(a).not.toBe(b);
  });
});

describe('logConnectFailure', () => {
  it('writes one line for a 4xx, with the step, status, code and request id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logConnectFailure({ step: '/token', status: 400, code: 'invalid_grant', requestId: 'req_abc0123456' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].join(' ');
    expect(line).toContain('/token');
    expect(line).toContain('400');
    expect(line).toContain('invalid_grant');
    expect(line).toContain('req_abc0123456');
  });

  it('says nothing for a healthy response — a 2xx, a 3xx, or no status', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logConnectFailure({ step: '/token', status: 200, requestId: 'req_x' });
    logConnectFailure({ step: '/token', status: 302, requestId: 'req_x' });
    logConnectFailure({ step: '/token', status: undefined, requestId: 'req_x' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('omits the code when there is none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logConnectFailure({ step: 'POST /api/mcp', status: 401, requestId: 'req_x' });
    const line = warn.mock.calls[0].join(' ');
    expect(line).toContain('401');
    expect(line).not.toMatch(/\bnull\b/);
  });
});

describe('errorCodeOf', () => {
  it('reads only the error code, never the description or anything else', () => {
    expect(errorCodeOf({ error: 'invalid_client', error_description: 'secret-echo-abc' })).toBe('invalid_client');
    expect(errorCodeOf({ error_description: 'no code here' })).toBeNull();
    expect(errorCodeOf('a string')).toBeNull();
    expect(errorCodeOf(null)).toBeNull();
  });

  it('caps a hostile code so it cannot flood the log', () => {
    expect(errorCodeOf({ error: 'x'.repeat(500) })).toHaveLength(64);
  });
});
