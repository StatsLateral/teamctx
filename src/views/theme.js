/**
 * One look, for every page teamctx serves.
 *
 * Ported from `StatsLateral/git-for-non-tech-teams` (`src/index.css`) — the
 * tokens, the fonts and the component styles, not the app. That app is React on
 * a June-era data model; what people liked about it is the paper, the numbered
 * tree and the drawer, and none of that needs a framework or a build step.
 *
 * Dark mode is new here. The old app had none, so every token is given a second
 * value under `prefers-color-scheme: dark` rather than the page being painted
 * light and hoping.
 */

export const esc = (v) => String(v).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

const FONTS = 'https://fonts.googleapis.com/css2'
  + '?family=Fraunces:wght@500;600'
  + '&family=Hanken+Grotesk:wght@400;500;600'
  + '&family=Spline+Sans+Mono:wght@500;600&display=swap';

/**
 * The tokens, light and dark.
 *
 * Light is the old app's palette unchanged. Dark keeps the same relationships —
 * paper behind, card raised off it, one accent — rather than inverting the
 * light values, which turns a warm paper into a muddy brown.
 */
const TOKENS = `
:root{
  --paper:#f4efe6;--card:#fcfaf5;--ink:#1a1c1a;--soft:#5a625b;--faint:#8a9088;
  --line:#e4dbcc;--accent:#1f6f5c;--accent-soft:#e6f0eb;--amber:#b5651d;--amber-soft:#f4e8da;
  --grey:#6b7280;--grey-soft:#ececea;--indigo:#4f46e5;--indigo-soft:#eef2ff;
  --radius:12px;--radius-sm:8px;
  --font-display:"Fraunces",Georgia,serif;
  --font-body:"Hanken Grotesk",-apple-system,BlinkMacSystemFont,sans-serif;
  --font-mono:"Spline Sans Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
/* The reader's machine decides, unless the reader has said otherwise. The
   :not([data-theme="light"]) is what lets them say otherwise: without it, a
   light choice on a dark machine would be overruled by the media query. */
@media(prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --paper:#16181a;--card:#1e2124;--ink:#e8e6e1;--soft:#a0a6a2;--faint:#7c837f;
    --line:#2f3438;--accent:#4aa88f;--accent-soft:#1d2f2a;--amber:#d08a4a;--amber-soft:#332417;
    --grey:#9aa0a6;--grey-soft:#2a2e31;--indigo:#8b87f0;--indigo-soft:#232338;
  }
}
:root[data-theme="dark"]{
    --paper:#16181a;--card:#1e2124;--ink:#e8e6e1;--soft:#a0a6a2;--faint:#7c837f;
    --line:#2f3438;--accent:#4aa88f;--accent-soft:#1d2f2a;--amber:#d08a4a;--amber-soft:#332417;
    --grey:#9aa0a6;--grey-soft:#2a2e31;--indigo:#8b87f0;--indigo-soft:#232338;
}`;

const BASE = `
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--font-body);
  line-height:1.55;-webkit-font-smoothing:antialiased;overflow-x:hidden}
/* A page starts near the top of the window. Two and a half rems above the nav
   read as a gap somebody forgot to fill rather than as breathing room. */
.page{max-width:34rem;margin:0 auto;padding:0 1.25rem 3rem}
/* The marker stays on <body>, where it has always been. */
body.wide .page{max-width:72rem}
h1{font-family:var(--font-display);font-weight:600;font-size:1.5rem;margin:0 0 .35rem}
h2{font-family:var(--font-display);font-weight:500;font-size:1.05rem;margin:0 0 .3rem}
p{color:var(--soft);margin-top:0}
a{color:var(--accent)}
code{font-family:var(--font-mono);font-size:.9em;background:var(--grey-soft);padding:.1rem .3rem;border-radius:4px}
/* A label above a section, in the mono face the old app used for them. */
.section-title{font-family:var(--font-mono);font-size:11px;text-transform:uppercase;
  letter-spacing:.08em;color:var(--soft);font-weight:600;margin:0 0 8px}
.muted{font-size:.85rem;color:var(--faint)}
.dim{color:var(--faint);font-weight:400}`;

const CHROME = `
/* The same bar on every screen, across the window rather than inside the
   column the page is read in. That column is 34rem on most pages, which the bar
   outgrew the moment it gained a switch — and a navigation that wraps onto two
   lines on some pages and not others is two navigations. */
.topbar{width:100vw;margin-left:calc(50% - 50vw);margin-bottom:1rem;
  border-bottom:1px solid var(--line);background:var(--paper)}
.bar{display:flex;align-items:center;gap:1.1rem;font-size:.9rem;
  max-width:72rem;margin:0 auto;padding:.65rem 1.25rem}
.bar .middle{display:flex;align-items:center;gap:1.1rem}
/* Small enough that they would collide: the middle links go, and the brand, the
   switch and who you are stay — which is what somebody needs on a phone. */
@media(max-width:44rem){.bar .middle{display:none}}
.bar .brand{font-family:var(--font-display);font-weight:600;color:inherit;text-decoration:none;margin-right:.4rem}
.bar a{text-decoration:none;color:var(--soft);padding:.2rem 0;border-bottom:2px solid transparent}
.bar a:hover{border-bottom-color:var(--line)}
.bar a.on{color:var(--ink);font-weight:600;border-bottom-color:var(--accent)}
.bar .who{padding-left:1.1rem;border-left:1px solid var(--line);color:var(--faint)}
/* Pushed to the far side, before whoever is signed in: the same corner on every
   page, whether or not there is anybody to name. */
.theme-toggle{margin-left:auto;border:1px solid var(--line);background:var(--card);color:var(--soft);
  border-radius:99px;width:30px;height:30px;padding:0;font-size:14px;line-height:1;cursor:pointer}
.theme-toggle:hover{color:var(--ink);border-color:var(--ink)}
.bar h1{margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  padding:1.15rem 1.3rem;margin:0 0 1.1rem;break-inside:avoid}
.cols{margin-top:1.25rem}
@media(min-width:52rem){.cols{columns:2;column-gap:1.1rem}}`;

const CONTROLS = `
button,.btn{font-family:inherit;font-size:14px;font-weight:500;cursor:pointer;
  border:1px solid var(--line);background:var(--card);color:var(--ink);
  border-radius:var(--radius-sm);padding:8px 14px;text-decoration:none;display:inline-block;
  transition:background .1s ease,border-color .1s ease}
button:hover:not(:disabled),.btn:hover{border-color:var(--ink)}
button:disabled{opacity:.5;cursor:not-allowed}
button.primary,.btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
button.primary:hover:not(:disabled),.btn.primary:hover{filter:brightness(1.08)}
button.ghost{background:transparent;border-color:transparent;color:var(--soft)}
button.ghost:hover:not(:disabled){color:var(--ink);background:var(--line)}
/* A way in that is shut stays on the page, greyed, with the reason under it. */
.btn.off{background:var(--grey-soft);color:var(--faint);cursor:not-allowed;border-color:var(--line)}
button.link{background:none;border:0;padding:0;margin:0;color:var(--faint);
  font-size:.85rem;text-decoration:underline;cursor:pointer}
.actions{display:flex;align-items:center;gap:.9rem;margin-top:1.6rem;flex-wrap:wrap}
label{display:block;font-weight:500;margin:1.25rem 0 .35rem;color:var(--ink)}
input,select,textarea{width:100%;box-sizing:border-box;padding:.55rem .7rem;font-size:1rem;
  font-family:inherit;border:1px solid var(--line);border-radius:var(--radius-sm);
  background:var(--card);color:var(--ink)}
/* The popup list is painted by the OS; a select with no colours of its own
   opted out of the scheme and rendered white-on-white. */
option{background:var(--card);color:var(--ink)}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.card label:first-of-type{margin-top:.75rem}
.card button[type=submit]{margin-top:1rem}
.ok{background:var(--accent-soft);color:var(--accent);padding:.6rem .8rem;border-radius:var(--radius-sm);margin:1rem 0}
.bad{background:var(--amber-soft);color:var(--amber);padding:.6rem .8rem;border-radius:var(--radius-sm);margin:1rem 0}
table{width:100%;border-collapse:collapse;font-size:.95rem}
th{text-align:left;font-weight:600;color:var(--faint);font-size:.8rem;text-transform:uppercase;letter-spacing:.03em}
th,td{padding:.4rem .5rem .4rem 0;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}`;

export const THEME_CSS = `${TOKENS}${BASE}${CHROME}${CONTROLS}`;

/**
 * A page.
 *
 * `extraCss` is for a page with styles nobody else needs — the project view's
 * tree and drawer — so every other page carries only what it uses. `script` is
 * the same bargain for behaviour.
 */
/**
 * Applied before anything is painted.
 *
 * A theme read after the first paint is a theme you watch arrive: the page
 * flashes paper and then goes dark. This runs in the head, before the body
 * exists, which is the only place that does not flash.
 */
const THEME_BOOT = `try{var t=localStorage.getItem('teamctx-theme');`
  + `if(t)document.documentElement.dataset.theme=t;}catch(e){}`;

/** Switching it, and remembering that you did. */
const THEME_SWITCH = `(function(){
  var b=document.getElementById('theme-toggle');
  if(!b)return;
  var dark=function(){
    var set=document.documentElement.dataset.theme;
    return set?set==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  var label=function(){b.textContent=dark()?'☀':'☾';b.title=dark()?'Switch to light':'Switch to dark';};
  label();
  b.addEventListener('click',function(){
    var next=dark()?'light':'dark';
    document.documentElement.dataset.theme=next;
    try{localStorage.setItem('teamctx-theme',next);}catch(e){}
    label();
  });
}());`;

export const shell = (title, body, { wide = false, extraCss = '', script = '' } = {}) => `<!doctype html>
<html lang="en"><head>
<script>${THEME_BOOT}</script>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — teamctx</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS}" rel="stylesheet">
<style>${THEME_CSS}${extraCss}</style>
</head><body${wide ? ' class="wide"' : ''}>
<div class="page">${body}</div>
<script>${THEME_SWITCH}</script>
${script ? `<script>${script}</script>` : ''}
</body></html>`;

/**
 * The bar across the top of every page.
 *
 * Only what this person can actually open is shown — offering Settings to
 * somebody who cannot open it is a dead end dressed as a choice.
 */
export const navBar = ({ user, current }) => {
  const link = (href, label) => (href === current
    ? `<a href="${href}" class="on" aria-current="page">${label}</a>`
    : `<a href="${href}">${label}</a>`);
  return `<header class="topbar"><nav class="bar">
  <a href="/" class="brand">teamctx</a>
  <span class="middle">
    ${link('/', 'Home')}
    ${user ? link('/projects', 'Projects') : ''}
    ${user ? link('/settings', 'Settings') : ''}
    ${user?.id ? link('/settings/new-project', 'New project') : ''}
  </span>
  <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Switch between light and dark"></button>
  <span class="who muted">${user ? `${esc(user.login || user.email || '')}
      <form method="POST" action="/settings/logout" style="display:inline;margin:0">
        <button type="submit" class="link">Sign out</button>
      </form>` : '<a href="/signin">Sign in</a>'}</span>
</nav></header>`;
};
