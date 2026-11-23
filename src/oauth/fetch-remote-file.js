import http from 'http';
import https from 'https';
import { lookup as dnsLookup } from 'dns';
import { isIP } from 'net';

/**
 * Fetch a file the model named only by URL, safely (#258).
 *
 * The by-reference inbound path lets a chatbot hand teamctx a file it already
 * holds — a platform's short-lived download URL, a cloud link — so the server
 * fetches the bytes and stores them as an ordinary output, and the model never
 * carries them. The URL comes from the model, so it is untrusted: fetching it
 * from inside the hosted network is a server-side request forgery risk, and an
 * unbounded body or a hanging host is a denial-of-service one.
 *
 * This fetch is therefore deliberately narrow:
 *
 * - **http/https only.** No file:, no data:, no gopher: — anything else is an
 *   attempt to reach something that is not a web file.
 * - **No private address, ever.** Every hostname is resolved and every resolved
 *   address checked against the loopback, private, link-local, carrier-NAT and
 *   reserved ranges before a single byte is sent, so a URL cannot be used to
 *   reach the metadata service, localhost or the internal network.
 * - **The checked address is the one we connect to.** A custom `lookup` pins the
 *   connection to the address that was validated, closing the DNS-rebinding
 *   window where a name resolves public for the check and private for the
 *   connection.
 * - **Redirects are followed but re-checked.** Each hop is validated the same
 *   way, so a public URL cannot 302 onto a private one, up to a small limit.
 * - **The body is capped and the request timed.** The stream is destroyed the
 *   moment it passes `maxBytes`, and the whole thing is abandoned after
 *   `timeoutMs`, so neither a huge file nor a slow one ties the server up.
 */

export class RemoteFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RemoteFetchError';
  }
}

const ipv4ToInt = ip => ip.split('.').reduce((acc, oct) => (acc * 256) + Number(oct), 0);
const inV4Range = (ip, cidr) => {
  const [range, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
};

// The ranges that must never be reached through a model-supplied URL: loopback,
// the private blocks, link-local (incl. the cloud metadata address 169.254.0.0/16),
// carrier-grade NAT, "this host", benchmarking, and multicast/reserved space.
const BLOCKED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '224.0.0.0/4', '240.0.0.0/4',
];

/**
 * Expand an IPv6 literal to its 16 bytes, or null if it does not parse. Handles
 * `::` compression and a trailing embedded dotted-IPv4 (`::ffff:1.2.3.4`), and
 * strips a zone id. Working in bytes is what lets the private-address check see
 * every embedding of an address rather than only the forms a string match knows.
 */
function ipv6ToBytes(ip) {
  let s = String(ip);
  const zone = s.indexOf('%'); if (zone >= 0) s = s.slice(0, zone);
  // A trailing dotted-IPv4 becomes two hextets, so the rest parses uniformly.
  const dotted = s.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) {
    const q = dotted[2].split('.').map(Number);
    if (q.some(n => n > 255)) return null;
    s = `${dotted[1]}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = halves.length === 2 ? [...head, ...Array(fill).fill('0'), ...tail] : head;
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    bytes[i * 2] = v >> 8; bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

/**
 * True when an IP literal (v4 or v6) is one we must never connect to.
 *
 * Every IPv6 form that embeds an IPv4 — mapped (`::ffff:a.b.c.d` and its hex
 * `::ffff:7f00:1`), compatible (`::a.b.c.d`), 6to4 (`2002::/16`) and NAT64
 * (`64:ff9b::/96`) — is judged by that embedded IPv4, so a loopback or private
 * address cannot slip past the v6 checks in any encoding.
 */
export function isPrivateAddress(ip) {
  const kind = isIP(ip);
  if (kind === 4) return BLOCKED_V4.some(cidr => inV4Range(ip, cidr));
  if (kind !== 6) return true; // not an address we can reason about — refuse it

  const b = ipv6ToBytes(ip);
  if (!b) return true; // a v6 literal we cannot expand — refuse it
  const v4 = o => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
  const zero = (lo, hi) => { for (let i = lo; i < hi; i++) if (b[i] !== 0) return false; return true; };

  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateAddress(v4(12)); // ::ffff:0:0/96 mapped
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true;     // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateAddress(v4(2));                    // 2002::/16 6to4
  // ::/96 compatible, but not :: (unspecified) or ::1 (loopback) handled below.
  if (zero(0, 12) && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] <= 1)) return isPrivateAddress(v4(12));

  if (zero(0, 15) && b[15] <= 1) return true;              // :: unspecified, ::1 loopback
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true;                 // fc00::/7 unique local
  if (b[0] === 0xff) return true;                          // ff00::/8 multicast
  return false;
}

/**
 * Resolve a hostname to a single address that is safe to connect to, or throw.
 *
 * A literal IP is checked as-is. A name is resolved to every address it has
 * (`all: true`) and refused if any one of them is private — not just the first —
 * so a name that answers with both a public and a private address cannot be used
 * to reach the private one. The returned address and family are what the
 * connection must then pin to.
 */
export function resolveSafeAddress(hostname, { lookup = dnsLookup, allowPrivate = false } = {}) {
  return new Promise((resolve, reject) => {
    const blocked = ip => !allowPrivate && isPrivateAddress(ip);
    const literal = isIP(hostname);
    if (literal) {
      if (blocked(hostname)) {
        reject(new RemoteFetchError(`that URL points at a non-public address (${hostname})`));
      } else {
        resolve({ address: hostname, family: literal });
      }
      return;
    }
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err) { reject(new RemoteFetchError(`that URL's host could not be resolved (${hostname})`)); return; }
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) { reject(new RemoteFetchError(`that URL's host resolved to nothing (${hostname})`)); return; }
      const bad = list.find(a => blocked(a.address));
      if (bad) { reject(new RemoteFetchError(`that URL resolves to a non-public address (${bad.address})`)); return; }
      resolve({ address: list[0].address, family: list[0].family });
    });
  });
}

/** The file's name, taken from the last path segment of the URL, or a fallback. */
export function fileNameFromUrl(urlString, fallback = 'download') {
  try {
    const u = new URL(urlString);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return last || fallback;
  } catch { return fallback; }
}

function assertWebUrl(urlString) {
  let u;
  try { u = new URL(urlString); }
  catch { throw new RemoteFetchError('that is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new RemoteFetchError(`only http and https URLs can be fetched, not ${u.protocol}`);
  }
  return u;
}

/**
 * Fetch the bytes at `urlString`, enforcing every guard above.
 *
 * Returns `{ bytes, contentType, fileName, finalUrl }`. Throws
 * {@link RemoteFetchError} for any refusal — a blocked address, a bad protocol,
 * a body over `maxBytes`, a timeout, too many redirects, or a non-2xx status —
 * with a message safe to show the person.
 */
export async function fetchRemoteFile(urlString, {
  maxBytes = 4 * 1024 * 1024,
  timeoutMs = 15000,
  maxRedirects = 5,
  lookup = dnsLookup,
  // Test-only: lets the suite exercise the transport against a loopback server.
  // Production call sites never pass it, so the private-address guard always holds.
  allowPrivate = false,
} = {}) {
  let current = assertWebUrl(urlString);
  // A wall-clock deadline over the whole fetch, redirects included: a server that
  // never responds, OR one that drips a byte at a time to stay under an idle
  // timeout, is abandoned once this passes — the operation cannot be held open.
  const deadline = Date.now() + timeoutMs;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safe = await resolveSafeAddress(current.hostname, { lookup, allowPrivate });
    const result = await new Promise((resolve, reject) => {
      const transport = current.protocol === 'https:' ? https : http;
      let timer;
      // Settle once and always clear the deadline timer, whichever way we leave.
      const finish = (fn, arg) => { clearTimeout(timer); fn(arg); };
      const req = transport.request(current, {
        method: 'GET',
        // Pin the connection to the address we validated. The Host header and TLS
        // SNI still carry the real hostname, so virtual hosts and certificates
        // keep working; only the IP is fixed, which is what shuts the rebind.
        // Node asks for every address (`all: true`) when it drives the lookup, so
        // answer in the shape it asked for: an array for `all`, else (addr, family).
        lookup: (_host, opts, cb) => (opts && opts.all
          ? cb(null, [{ address: safe.address, family: safe.family }])
          : cb(null, safe.address, safe.family)),
        // identity: don't let an origin gzip the body unsolicited — we store the
        // bytes verbatim and type-check them, so a compressed stream would fail.
        headers: { 'user-agent': 'teamctx', accept: '*/*', 'accept-encoding': 'identity' },
      }, res => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          // Don't download the body we're about to discard: tear the request down
          // rather than drain an unbounded redirect body, then re-request the target.
          req.destroy();
          try { finish(resolve, { redirectTo: new URL(location, current) }); }
          catch { finish(reject, new RemoteFetchError('that URL redirected to an invalid location')); }
          return;
        }
        if (status < 200 || status >= 300) {
          req.destroy(); // same: a non-2xx error body is uncapped, so don't read it
          finish(reject, new RemoteFetchError(`fetching that URL returned HTTP ${status}`));
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', chunk => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy();
            finish(reject, new RemoteFetchError(`that file is larger than the ${maxBytes} byte limit`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(resolve, {
          bytes: Buffer.concat(chunks),
          contentType: String(res.headers['content-type'] || '').split(';')[0].trim() || null,
        }));
        res.on('error', e => finish(reject, new RemoteFetchError(`that URL could not be read: ${e.message}`)));
      });
      timer = setTimeout(() => {
        req.destroy();
        finish(reject, new RemoteFetchError(`fetching that URL timed out after ${timeoutMs} ms`));
      }, Math.max(1, deadline - Date.now()));
      req.on('error', e => {
        if (e instanceof RemoteFetchError) finish(reject, e);
        else finish(reject, new RemoteFetchError(`that URL could not be reached: ${e.message}`));
      });
      req.end();
    });

    if (result.redirectTo) {
      current = assertWebUrl(result.redirectTo.href);
      continue;
    }
    return {
      bytes: result.bytes,
      contentType: result.contentType,
      fileName: fileNameFromUrl(current.href),
      finalUrl: current.href,
    };
  }
  throw new RemoteFetchError(`that URL redirected more than ${maxRedirects} times`);
}
