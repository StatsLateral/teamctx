/**
 * Catch an obvious secret in an upload before its bytes go into the project's
 * git repository (#252).
 *
 * A committed credential stays in history even after the task or output is
 * removed, so the one place every upload passes through (`validateFileOutput`)
 * scans its text and refuses when it finds something that looks like a key or
 * token. The person can rotate it, or attach anyway with an explicit override.
 *
 * The detectors are NOT hand-rolled. They are a curated subset of the rules
 * published by gitleaks (MIT, https://github.com/gitleaks/gitleaks,
 * `config/gitleaks.toml`) — the high-signal, low-false-positive ones. They are
 * embedded here as data so the hosted serverless function stays small; no
 * scanner binary and no heavy dependency is pulled in.
 */

// Minimum Shannon entropy (bits per character) for the one generic
// keyword-and-value rule, to keep ordinary assignments (password = "changeme")
// from tripping it. The provider-specific rules need no entropy gate: their
// shape alone is the signal.
const GENERIC_MIN_ENTROPY = 3.5;

/**
 * Each rule: a name, a global regex, and whether its captured value must clear
 * the entropy gate. `group` is the capture group that holds the secret itself
 * (for redaction and entropy); 0 means the whole match.
 */
const RULES = [
  {
    name: 'private-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    group: 0,
  },
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g, group: 0 },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/g, group: 0 },
  { name: 'github-fine-grained-token', re: /\bgithub_pat_[0-9A-Za-z_]{82}\b/g, group: 0 },
  { name: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, group: 0 },
  { name: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/T[0-9A-Z]+\/B[0-9A-Z]+\/[0-9A-Za-z]+/g, group: 0 },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g, group: 0 },
  { name: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, group: 0 },
  // The fixed `T3BlbkFJ` marker is what makes an OpenAI key recognisable; a bare
  // `sk-<slug>` would flag ordinary `sk-`-prefixed identifiers, so gitleaks keys
  // on the marker and so do we. A keyed `sk-proj-…=…` is still caught by the
  // generic rule below.
  { name: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/g, group: 0 },
  // Anthropic keys carry their own distinctive prefix (`sk-ant-api03-`,
  // `sk-ant-admin01-`), so unlike a bare `sk-` the prefix alone is the signal and
  // no entropy gate is needed. People using teamctx are especially likely to
  // paste one. Matches the gitleaks `anthropic-api-key` shape.
  { name: 'anthropic-api-key', re: /\bsk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{80,}\b/g, group: 0 },
  { name: 'jwt', re: /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/g, group: 0 },
  {
    // Generic: a credential-ish name assigned a long value. Entropy-gated so a
    // real-looking token is caught but a placeholder is not.
    name: 'generic-api-key',
    re: /(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret|auth)['"]?\s*[:=]\s*['"]?([0-9A-Za-z/+._\-]{20,})['"]?/gi,
    group: 1,
    entropy: true,
  },
];

/** Shannon entropy in bits per character — a rough "does this look random". */
export function entropyOf(s) {
  if (!s) return 0;
  const counts = Object.create(null);
  for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
  let bits = 0;
  for (const ch in counts) {
    const p = counts[ch] / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Show enough of a matched secret to recognise it, never the whole thing: the
 * first few and last couple of characters, the middle replaced by an ellipsis.
 *
 * `prefixOnly` drops the trailing characters and shows only the first few. The
 * provider rules match a whole token with a fixed shape, so a head and tail
 * identify it safely; the generic rule matches an arbitrary assigned value, where
 * the tail could be the live part of a short credential — so for it, show the
 * head alone.
 */
export function redactSecret(s, prefixOnly = false) {
  const str = String(s);
  if (str.length <= 8) return `${str.slice(0, 2)}…`;
  if (prefixOnly) return `${str.slice(0, 4)}…`;
  return `${str.slice(0, 4)}…${str.slice(-2)}`;
}

/**
 * Scan text for obvious secrets.
 *
 * @param {string} text
 * @returns {Array<{ rule: string, line: number, match: string }>}  findings,
 *   one per match, `match` already redacted, `line` 1-based. Deduplicated by
 *   rule+line+redaction so one key repeated on a line is reported once.
 */
export function scanForSecrets(text) {
  if (typeof text !== 'string' || !text) return [];

  // Run the rules first and collect raw hits. A clean file — the common case —
  // never pays for the line index below.
  const hits = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      // A zero-width match would loop forever; our patterns never match empty,
      // but guard anyway.
      if (m[0] === '') { rule.re.lastIndex += 1; continue; }
      const value = rule.group ? (m[rule.group] || '') : m[0];
      if (rule.entropy && entropyOf(value) < GENERIC_MIN_ENTROPY) continue;
      const offset = rule.group ? m.index + m[0].indexOf(value) : m.index;
      hits.push({ rule: rule.name, offset, value });
    }
  }
  if (hits.length === 0) return [];

  // Only now turn offsets into line numbers. One native pass over the newlines
  // builds the index; a binary search then maps each (few) offset to its line.
  const lineStarts = [0];
  const nl = /\n/g;
  let nm;
  while ((nm = nl.exec(text)) !== null) lineStarts.push(nm.index + 1);
  const lineAt = (offset) => {
    let lo = 0; let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const findings = [];
  const seen = new Set();
  for (const hit of hits) {
    const line = lineAt(hit.offset);
    const redacted = redactSecret(hit.value, hit.rule === 'generic-api-key');
    const key = `${hit.rule}:${line}:${redacted}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ rule: hit.rule, line, match: redacted });
  }
  findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return findings;
}

/**
 * A one-line-per-finding message for a refusal, naming the rule, line and the
 * redacted match — enough to find and judge it, never the secret itself.
 */
export function describeSecretFindings(findings) {
  return findings
    .map(f => `  - line ${f.line}: looks like a ${f.rule} (${f.match})`)
    .join('\n');
}
