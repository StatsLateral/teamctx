/**
 * Nothing in `dependencies` that no file imports.
 *
 * `@vercel/kv` sat there for months with nothing importing it:
 * `src/oauth/kv.js` speaks the Upstash REST protocol over `fetch` directly, so
 * the package only added install weight and implied a storage backend we do not
 * use. Nothing failed, because an unused dependency cannot fail — being
 * installed is exactly the thing that proves nothing.
 *
 * So the manifest is checked against the import graph rather than by eye. The
 * specifiers are read out of the source instead of resolved, for the same
 * reason: a package that is present is importable whether anybody imports it
 * or not.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const tracked = () => execFileSync('git', ['ls-files', '*.js'], { cwd: root, encoding: 'utf8' })
  .split('\n').map(f => f.trim()).filter(Boolean);

/** `@scope/pkg/sub/path.js` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
export function packageOf(specifier) {
  const parts = String(specifier).split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Bare specifiers only. A relative path or a `node:` builtin is not a
 * dependency. Specifiers never contain a newline, which is what keeps prose
 * ending in the word "import" from reading as one.
 */
export function specifiersIn(source) {
  const found = new Set();
  const patterns = [
    /\bimport\s+[^'"\n]*?from\s*['"]([^'"\n]+)['"]/g,
    /^[ \t]*import\s*['"]([^'"\n]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\bvi\.mock\s*\(\s*['"]([^'"\n]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const [, spec] of source.matchAll(re)) {
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      found.add(packageOf(spec));
    }
  }
  return found;
}

const importedPackages = () => {
  const all = new Set();
  for (const file of tracked()) {
    for (const pkg of specifiersIn(readFileSync(join(root, file), 'utf8'))) all.add(pkg);
  }
  return all;
};

describe('every declared dependency is reached from the source', () => {
  it('has nothing in dependencies that no file imports', () => {
    const imported = importedPackages();
    const unused = Object.keys(manifest.dependencies || {}).filter(p => !imported.has(p));
    expect(unused).toEqual([]);
  });

  it('no longer carries @vercel/kv, because kv.js wants fetch and not an SDK', () => {
    // Named rather than left to the sweep above, so the reason is on the record
    // if somebody reaches for a Redis client again.
    expect(manifest.dependencies).not.toHaveProperty('@vercel/kv');
    expect(readFileSync(join(root, 'src/oauth/kv.js'), 'utf8')).toContain('fetch(');
  });

  it('still reads both env var namings, so deployments do not have to change', () => {
    const kv = readFileSync(join(root, 'src/oauth/kv.js'), 'utf8');
    expect(kv).toContain('KV_REST_API_URL');
    expect(kv).toContain('UPSTASH_REDIS_REST_URL');
  });
});

describe('the sweep would notice', () => {
  it('reports a dependency nothing imports', () => {
    // Proves the check does work rather than passing because the manifest is
    // short: the exact package that was removed, put back into a copy of it.
    const pretend = { ...manifest.dependencies, '@vercel/kv': '^3.0.0' };
    const imported = importedPackages();
    expect(Object.keys(pretend).filter(p => !imported.has(p))).toEqual(['@vercel/kv']);
  });

  it('reads a package name out of a subpath import', () => {
    expect(packageOf('@modelcontextprotocol/sdk/server/mcp.js')).toBe('@modelcontextprotocol/sdk');
    expect(packageOf('dotenv/config')).toBe('dotenv');
  });

  it('ignores relative paths and builtins', () => {
    const found = specifiersIn([
      "import { a } from './local.js';",
      "import fs from 'node:fs';",
      "import { Command } from 'commander';",
    ].join('\n'));
    expect([...found]).toEqual(['commander']);
  });

  it('sees a package reached only through a dynamic import, require or mock', () => {
    expect([...specifiersIn("const x = await import('openai');")]).toEqual(['openai']);
    expect([...specifiersIn("const y = require('jsonrepair');")]).toEqual(['jsonrepair']);
    expect([...specifiersIn("vi.mock('commander', () => ({}));")]).toEqual(['commander']);
  });

  it('does not mistake a sentence ending in the word import for one', () => {
    // A real test name in src/connectors/dropbox.test.js ends "nothing to
    // import', async () => {", which a looser pattern read as a specifier.
    const found = specifiersIn("it('reports nothing to import', async () => {\n  ok();\n});");
    expect([...found]).toEqual([]);
  });
});
