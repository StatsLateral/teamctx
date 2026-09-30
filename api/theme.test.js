/**
 * One look, on every page.
 *
 * #103 part 1 restyles the whole web surface and moves the templates out of the
 * routes file — with no behaviour change. What is checked here is the part that
 * is easy to get half-right: every page really does carry the theme, dark mode
 * is defined for every token, and nothing under `api/` grew into a serverless
 * function while the files were being moved.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { THEME_CSS, shell, esc } from '../src/views/theme.js';

let server, base;
beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://team.example.app';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

const get = async (path) => (await fetch(base + path)).text();

describe('the theme', () => {
  it('carries the tokens the old app was built on', async () => {
    // Ported from git-for-non-tech-teams/src/index.css — the look is the thing
    // people liked, and it is not ours to reinvent.
    for (const token of ['--paper:#f4efe6', '--card:#fcfaf5', '--ink:#1a1c1a',
                         '--line:#e4dbcc', '--accent:#1f6f5c', '--radius:12px']) {
      expect(THEME_CSS, token).toContain(token);
    }
  });

  it('names all three fonts', () => {
    for (const font of ['Fraunces', 'Hanken Grotesk', 'Spline Sans Mono']) {
      expect(THEME_CSS).toContain(font);
    }
  });

  it('gives every colour token a dark value, not only some of them', () => {
    // Half a dark mode is worse than none: the ones left behind stay light and
    // the page ends up unreadable in exactly the places nobody checked.
    const dark = THEME_CSS.slice(THEME_CSS.indexOf('prefers-color-scheme:dark'));
    const light = THEME_CSS.slice(0, THEME_CSS.indexOf('@media'));
    const colours = [...light.matchAll(/(--[a-z-]+):#[0-9a-f]{6}/g)].map(m => m[1]);
    expect(colours.length).toBeGreaterThan(10);
    for (const name of colours) expect(dark, name).toContain(`${name}:`);
  });

  it('escapes what people wrote into the title', () => {
    expect(shell('</title><script>x</script>', 'body')).not.toContain('<script>x</script>');
    expect(esc('<b>&"')).toBe('&lt;b&gt;&amp;&quot;');
  });

  it('keeps a page narrow by default and wide when asked', () => {
    expect(shell('t', 'b')).not.toContain('class="wide"');
    expect(shell('t', 'b', { wide: true })).toContain('<body class="wide">');
  });
});

describe('every page wears it', () => {
  for (const [name, path] of [['home', '/'], ['sign-in', '/signin'], ['settings', '/settings']]) {
    it(`${name} carries the theme and the fonts`, async () => {
      const body = await get(path);
      expect(body).toContain('--paper:#f4efe6');
      expect(body).toContain('Fraunces');
      expect(body).toContain('prefers-color-scheme:dark');
    });
  }
});

describe('what the move did not do', () => {
  it('left no new serverless functions behind', () => {
    // Vercel turns every .js under api/ into a function, and the Hobby plan
    // allows twelve. The templates live in src/views/ for that reason.
    const walk = (dir) => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    const functions = walk('api').filter(p => p.endsWith('.js') && !p.endsWith('.test.js'));
    expect(functions.length).toBeLessThanOrEqual(12);
  });
});
