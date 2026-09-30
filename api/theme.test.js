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

describe('choosing light or dark', () => {
  it('follows the machine when nobody has chosen', () => {
    expect(THEME_CSS).toContain('@media(prefers-color-scheme:dark)');
  });

  it('lets a choice override the machine, in both directions', () => {
    // Without the :not(), a light choice on a dark machine loses to the media
    // query and the switch appears broken to exactly the person who used it.
    expect(THEME_CSS).toContain(':root:not([data-theme="light"])');
    expect(THEME_CSS).toContain(':root[data-theme="dark"]');
  });

  it('gives the override every token the machine gets', () => {
    const between = (a, b) => THEME_CSS.slice(THEME_CSS.indexOf(a), b ? THEME_CSS.indexOf(b) : undefined);
    const media = between('@media(prefers-color-scheme:dark)', ':root[data-theme="dark"]');
    const chosen = between(':root[data-theme="dark"]');
    const names = (css) => [...css.matchAll(/(--[a-z-]+):/g)].map(m => m[1]).sort();
    expect(names(chosen)).toEqual(names(media));
  });

  it('reads the choice before anything is painted', async () => {
    // Read after the first paint and the page flashes paper, then goes dark.
    const body = await get('/settings');
    const head = body.slice(0, body.indexOf('</head>'));
    expect(head).toContain("localStorage.getItem('teamctx-theme')");
  });

  it('puts the switch in the same corner on every page', async () => {
    for (const path of ['/', '/signin', '/settings']) {
      const body = await get(path);
      expect(body, path).toContain('id="theme-toggle"');
      expect(body, path).toContain("localStorage.setItem('teamctx-theme'");
    }
  });
});

describe('one navigation, on every screen', () => {
  it('spans the window rather than the column the page is read in', async () => {
    // The column is 34rem on most pages, which the bar outgrew when it gained a
    // switch — and who you were wrapped onto a line of their own.
    const body = await get('/settings');
    expect(body).toContain('.topbar{width:100vw');
    expect(body).toMatch(/\.bar\{[^}]*max-width:72rem/);
    expect(body).not.toMatch(/\.bar\{[^}]*flex-wrap:wrap/);
  });

  it('is the same bar whether the page is narrow or wide', async () => {
    const narrow = await get('/settings');
    const wide = await get('/projects');
    const bar = (html) => html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
    expect(bar(narrow).replace(/ class="on"[^>]*/g, '')).toBe(bar(wide).replace(/ class="on"[^>]*/g, ''));
  });

  it('keeps the brand, the switch and who you are when there is no room for links', async () => {
    const body = await get('/settings');
    expect(body).toContain('@media(max-width:44rem){.bar .middle{display:none}}');
    expect(body).toContain('class="middle"');
  });
});

describe('nothing reaches sideways', () => {
  it('clips the page rather than scrolling it', async () => {
    // The bar spans the viewport, and viewport width counts the scrollbar.
    const body = await get('/settings');
    expect(body).toContain('html{overflow-x:clip}');
    expect(body).toMatch(/body\{[^}]*overflow-x:clip/);
  });

  it('wraps a long word instead of pushing what holds it', async () => {
    expect(THEME_CSS).toMatch(/overflow-wrap:anywhere/);
  });

  it('lets the browser paint its chrome in the theme actually in force', async () => {
    // `light dark` painted a dark scrollbar on a page the reader had switched
    // to light, because the browser was reading the machine, not the page.
    expect(THEME_CSS).not.toContain('color-scheme:light dark');
    expect(THEME_CSS).toMatch(/color-scheme:light;/);
    expect(THEME_CSS).toMatch(/\[data-theme="dark"\]\{\s*color-scheme:dark/);
    expect(THEME_CSS).toMatch(/\[data-theme="light"\]\{color-scheme:light\}/);
  });
});
