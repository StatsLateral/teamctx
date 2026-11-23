import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import {
  isPrivateAddress, resolveSafeAddress, fileNameFromUrl, fetchRemoteFile, RemoteFetchError,
} from './fetch-remote-file.js';

describe('isPrivateAddress — the ranges a model-supplied URL must never reach', () => {
  it('blocks IPv4 loopback, private, link-local, carrier-NAT and reserved', () => {
    for (const ip of [
      '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.9.9', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1',
    ]) expect(isPrivateAddress(ip), ip).toBe(true);
  });

  it('allows ordinary public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('blocks IPv6 loopback, unspecified, link-local, unique-local and multicast', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('unwraps an IPv4-mapped IPv6 address and judges it as IPv4', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('blocks every other embedding of a private IPv4 — hex-mapped, 6to4 and NAT64', () => {
    // These are all 127.0.0.1 or 10.0.0.1 wearing a different IPv6 coat; a string
    // match on the dotted form alone would let them through.
    for (const ip of ['::ffff:7f00:1', '::ffff:0a00:1', '2002:7f00:1::', '64:ff9b::7f00:1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    // A public IPv4 embedded the same way stays public.
    expect(isPrivateAddress('::ffff:0808:0808')).toBe(false); // 8.8.8.8 in hex
    expect(isPrivateAddress('2002:0808:0808::')).toBe(false); // 8.8.8.8 via 6to4
  });

  it('refuses an IPv6 literal it cannot parse', () => {
    expect(isPrivateAddress('::gggg')).toBe(true);
  });

  it('allows a public IPv6 address', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('refuses anything that is not an address at all', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('resolveSafeAddress — DNS is checked before we connect', () => {
  const lookupReturning = (...addrs) => (host, opts, cb) => cb(null, addrs.map(address => ({ address, family: address.includes(':') ? 6 : 4 })));

  it('passes a name that resolves only to public addresses', async () => {
    const { address } = await resolveSafeAddress('example.com', { lookup: lookupReturning('93.184.216.34') });
    expect(address).toBe('93.184.216.34');
  });

  it('refuses a name that resolves to any private address, even alongside a public one', async () => {
    await expect(resolveSafeAddress('rebind.test', { lookup: lookupReturning('93.184.216.34', '169.254.169.254') }))
      .rejects.toBeInstanceOf(RemoteFetchError);
  });

  it('refuses a literal private IP without any DNS', async () => {
    await expect(resolveSafeAddress('127.0.0.1')).rejects.toBeInstanceOf(RemoteFetchError);
  });

  it('passes a literal public IP', async () => {
    const { address } = await resolveSafeAddress('8.8.8.8');
    expect(address).toBe('8.8.8.8');
  });

  it('surfaces a resolution failure as a RemoteFetchError', async () => {
    await expect(resolveSafeAddress('nope.invalid', { lookup: (h, o, cb) => cb(new Error('ENOTFOUND')) }))
      .rejects.toBeInstanceOf(RemoteFetchError);
  });
});

describe('fileNameFromUrl', () => {
  it('takes the last path segment', () => {
    expect(fileNameFromUrl('https://host.example/a/b/chart.png')).toBe('chart.png');
    expect(fileNameFromUrl('https://host.example/a/b/chart.png?x=1#y')).toBe('chart.png');
  });
  it('decodes percent-escapes', () => {
    expect(fileNameFromUrl('https://host.example/my%20report.pdf')).toBe('my report.pdf');
  });
  it('falls back when there is no segment', () => {
    expect(fileNameFromUrl('https://host.example/')).toBe('download');
    expect(fileNameFromUrl('not a url', 'x.bin')).toBe('x.bin');
  });
});

describe('fetchRemoteFile — protocol and URL guards', () => {
  it('refuses a non-web protocol', async () => {
    await expect(fetchRemoteFile('file:///etc/passwd')).rejects.toThrow(/only http and https/);
    await expect(fetchRemoteFile('data:text/plain,hi')).rejects.toThrow(/only http and https/);
  });
  it('refuses a malformed URL', async () => {
    await expect(fetchRemoteFile('http://')).rejects.toBeInstanceOf(RemoteFetchError);
  });
  it('refuses a private host before connecting (the SSRF guard)', async () => {
    // No allowPrivate here: a loopback URL must be refused outright.
    await expect(fetchRemoteFile('http://127.0.0.1:1/x')).rejects.toThrow(/non-public address/);
  });
});

describe('fetchRemoteFile — transport, against a loopback server (allowPrivate for the test only)', () => {
  let server, origin;
  const routes = {};
  beforeAll(async () => {
    server = http.createServer((req, res) => (routes[req.url] || routes['*'])(req, res));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => server?.close());

  it('fetches bytes and the content type', async () => {
    routes['/chart.png'] = (_req, res) => { res.setHeader('content-type', 'image/png; charset=binary'); res.end(Buffer.from([1, 2, 3, 4])); };
    const out = await fetchRemoteFile(`${origin}/chart.png`, { allowPrivate: true });
    expect([...out.bytes]).toEqual([1, 2, 3, 4]);
    expect(out.contentType).toBe('image/png');
    expect(out.fileName).toBe('chart.png');
  });

  it('pins the connection through the lookup when the host is a name, not a literal IP', async () => {
    // A literal-IP URL skips Node's `lookup` entirely, so only a hostname
    // exercises the pinned lookup — and Node drives it with `all: true`, so the
    // callback has to answer with an array. This is the real-world path (every
    // name-based fetch); a loopback-literal URL never reaches it.
    routes['/pinned.txt'] = (_req, res) => { res.end('pinned'); };
    const port = server.address().port;
    const toLoopback = (_host, _opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    const out = await fetchRemoteFile(`http://pinned.test:${port}/pinned.txt`, { allowPrivate: true, lookup: toLoopback });
    expect(out.bytes.toString()).toBe('pinned');
  });

  it('caps the body and destroys the stream past the limit', async () => {
    routes['/big.bin'] = (_req, res) => { res.end(Buffer.alloc(10000, 7)); };
    await expect(fetchRemoteFile(`${origin}/big.bin`, { allowPrivate: true, maxBytes: 1000 }))
      .rejects.toThrow(/larger than/);
  });

  it('follows a redirect, re-checking each hop', async () => {
    routes['/go'] = (_req, res) => { res.writeHead(302, { location: `${origin}/dest.txt` }); res.end(); };
    routes['/dest.txt'] = (_req, res) => { res.end('landed'); };
    const out = await fetchRemoteFile(`${origin}/go`, { allowPrivate: true });
    expect(out.bytes.toString()).toBe('landed');
    expect(out.fileName).toBe('dest.txt');
  });

  it('gives up after too many redirects', async () => {
    routes['/loop'] = (_req, res) => { res.writeHead(302, { location: `${origin}/loop` }); res.end(); };
    await expect(fetchRemoteFile(`${origin}/loop`, { allowPrivate: true, maxRedirects: 2 }))
      .rejects.toThrow(/redirected more than/);
  });

  it('turns a non-2xx status into a clean error', async () => {
    routes['/missing'] = (_req, res) => { res.writeHead(404); res.end('no'); };
    await expect(fetchRemoteFile(`${origin}/missing`, { allowPrivate: true })).rejects.toThrow(/HTTP 404/);
  });

  it('times out a slow response', async () => {
    routes['/slow'] = (_req, res) => { res.writeHead(200); res.write('a'); /* never ends */ };
    await expect(fetchRemoteFile(`${origin}/slow`, { allowPrivate: true, timeoutMs: 150 })).rejects.toThrow(/timed out/);
  });

  it('abandons a server that drips bytes to stay under an idle timeout', async () => {
    // One byte every 30ms would keep resetting a socket idle-timeout forever; the
    // wall-clock deadline still fires at timeoutMs.
    routes['/drip'] = (_req, res) => {
      res.writeHead(200);
      const iv = setInterval(() => { try { res.write('.'); } catch { clearInterval(iv); } }, 30);
      res.on('close', () => clearInterval(iv));
    };
    await expect(fetchRemoteFile(`${origin}/drip`, { allowPrivate: true, timeoutMs: 150 }))
      .rejects.toThrow(/timed out/);
  });

  it('asks the origin not to compress the body', async () => {
    let seen;
    routes['/enc'] = (req, res) => { seen = req.headers['accept-encoding']; res.end('ok'); };
    await fetchRemoteFile(`${origin}/enc`, { allowPrivate: true });
    expect(seen).toBe('identity');
  });

  it('does not read the body of a non-2xx response', async () => {
    let bytesRead = 0;
    routes['/err'] = (req, res) => {
      req.socket.on('close', () => {}); // keep the test server quiet on abort
      res.writeHead(404);
      // A large error body: if we drained it, bytesRead would climb before the reject.
      const iv = setInterval(() => { try { res.write('x'.repeat(1000)); bytesRead += 1000; } catch { clearInterval(iv); } }, 5);
      res.on('close', () => clearInterval(iv));
    };
    await expect(fetchRemoteFile(`${origin}/err`, { allowPrivate: true })).rejects.toThrow(/HTTP 404/);
    const atReject = bytesRead;
    await new Promise(r => setTimeout(r, 60));
    // The request was torn down, so the server stopped being able to push more.
    expect(bytesRead - atReject).toBeLessThan(5000);
  });
});
