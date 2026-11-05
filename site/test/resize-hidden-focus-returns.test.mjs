// Adversary round 56 on the site (2be81cb..c828cc7). Intended home: site/test/resize-hidden-focus-returns.test.mjs
// Run from the repo root: node --test site/test/resize-hidden-focus-returns.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// Round 45 (menu-close-keeps-focus.test.mjs) held that a width change which hides the focused control must not
// drop focus to <body>, and site.js setMenu() now says so: "Closed with focus inside (... the window growing
// past 1020px): give it back to something visible." Three other controls are hidden by a width change, and
// nothing in site.js moves focus off them first:
//   1. The docs menu summary ("Docs menu"). site.css:900 `.docs-nav summary { display: none }`, shown only in
//      site.css:969 `@media (max-width: 860px)`. Round 55's fix, site.js:230, listens for that query and only
//      sets `docsNav.open = true`. A keyboard user at 200% zoom (a 1440px laptop lays out at 720px) closes or
//      opens the menu from its summary, then presses Ctrl+0: the summary they are on goes display: none.
//   2. A link in "On this page" (.toc). site.css:968 `@media (max-width: 1180px) { ... .toc { display: none } }`,
//      and site.js has no listener for that width at all. Ctrl+plus from 100% on a 1280 to 1440px laptop.
//   3. The menu button while the menu is closed. site.css hides .icon-btn above 1020px; site.js:54's 1021px
//      listener calls setMenu(false), which returns focus only if `menu.contains(document.activeElement)`.
// Measured on the built pages (adv-site-r56 worktree at c828cc7, dist as built), headless Chromium
// (playwright-core, chrome-headless-shell 1243), 2026-11-05, every non-site request aborted (CDN failed),
// docs/reference.html (probe/focuscross.mjs beside this file: focus, resize, read document.activeElement):
//   summary, Enter to close, 800x900 -> 1024x768:
//     before active=SUMMARY. "Docs menu" details.open=false
//     after  active=BODY.docs-page vw=1024 details.open=true
//   summary, menu left open, 800x900 -> 1024x768: after active=BODY.docs-page
//   toc link "CLI commands", 1280x800 -> 1024x768: after active=BODY.docs-page; next Tab lands on footer "GitHub"
//   menu button (menu closed), 900x800 -> 1280x800: after active=BODY.docs-page
// With focus on <body> a screen reader announces the document again and the reader has lost their place
// (WCAG 2.2 SC 2.4.3 Focus Order; site/README.md and the round brief count lost focus as a failure). The same
// script runs in the CDN-failed and the working state, since site.js has no dependencies.
//
// The test needs no browser. For each control it asserts one of: CSS no longer hides it at the far side of its
// breakpoint, or site.js watches focus leave (a focusin, focusout or blur listener) and puts it back with a focus
// call, from that listener or from a listener on the width change. A width listener alone does not pass: it races
// Chromium's own move of focus to <body> (see returnsFocus below).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(src, 'static', 'assets', 'site.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The text of a balanced (...) or {...} group that opens at or after `from`.
function group(text, from, open = '(') {
  const close = open === '(' ? ')' : '}';
  const start = text.indexOf(open, from);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return '';
}

// Style rules with the @media preludes around them.
function rules(text) {
  const out = [];
  const parse = (str, media) => {
    let i = 0;
    while (i < str.length) {
      const open = str.indexOf('{', i);
      if (open < 0) break;
      const prelude = str.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < str.length && depth) { if (str[j] === '{') depth++; else if (str[j] === '}') depth--; j++; }
      const inner = str.slice(open + 1, j - 1);
      if (prelude.startsWith('@media')) parse(inner, [...media, prelude.slice(6).trim()]);
      else if (!prelude.startsWith('@')) out.push({ sels: prelude.split(',').map(s => s.trim().replace(/\s+/g, ' ')), media, body: inner });
      i = j;
    }
  };
  parse(text, []);
  return out;
}
const RULES = rules(css);
// The display value the cascade gives `selector` at CSS width w (width features only; later rules win).
function display(selectors, w) {
  let val;
  const holds = q => q.split(/\s+and\s+/i).every(c => {
    const m = c.match(/\(\s*(min|max)-width:\s*([\d.]+)px\s*\)/);
    if (!m) return !/\(/.test(c) || undefined;
    return m[1] === 'min' ? w >= Number(m[2]) : w <= Number(m[2]);
  });
  for (const r of RULES) {
    if (!r.sels.some(s => selectors.includes(s))) continue;
    if (!r.media.every(q => holds(q) === true)) continue;
    const d = r.body.match(/(?:^|;)\s*display\s*:\s*([^;]+)/);
    if (d) val = d[1].trim();
  }
  return val;
}

// Every listener site.js attaches to a width change, with the query (or 'resize'), and every focus listener.
const listeners = [];
for (const m of js.matchAll(/matchMedia\(\s*['"]([^'"]+)['"]\s*\)\s*\.addEventListener\(/g)) {
  listeners.push({ query: m[1], body: group(js, m.index + m[0].length - 1) });
}
for (const m of js.matchAll(/addEventListener\(\s*['"]resize['"]/g)) listeners.push({ query: 'resize', body: group(js, m.index + 'addEventListener'.length) });
const trackers = [...js.matchAll(/addEventListener\(\s*['"](?:focusin|focusout|blur)['"]/g)].map(m => group(js, m.index + 'addEventListener'.length));
// A handler may call a named function; fold its body in.
const fnBody = name => {
  const at = js.search(new RegExp(`(?:const|let|function)\\s+${name}\\s*(?:=\\s*(?:\\([^)]*\\)|\\w+)\\s*=>|\\()`));
  return at < 0 ? '' : group(js, js.indexOf('{', at), '{');
};
const expand = body => body + [...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(m => (/^(if|focus|matches|addEventListener)$/.test(m[1]) ? '' : fnBody(m[1]))).join('');
const crosses = (query, px) => query === 'resize' || new RegExp(`(?:max-width:\\s*${px}(?:\\.\\d+)?px|min-width:\\s*${px + 1}px)`).test(query);
// Chromium moves focus off the hidden control to <body> either before or after the width listeners run, from one
// run to the next (probe/focusrepeat.mjs: a width listener that tests document.activeElement and refocuses rescued
// focus in 3, 4, 1 and 3 of 6 runs for the four cases; a focusout listener did in 24 of 24). So the fix must see
// focus leave (focusin, focusout or blur) and then put it somewhere, from that listener or from the width listener.
const returnsFocus = px => trackers.length > 0 && (
  trackers.some(b => /\.focus\s*\(/.test(expand(b)))
  || listeners.filter(l => crosses(l.query, px)).some(l => /\.focus\s*\(/.test(expand(l.body))));

test('precondition: the three controls are shown on one side of a width and display: none on the other', () => {
  assert.equal(display(['.docs-nav summary'], 860), 'flex', 'docs menu summary shown at 860px');
  assert.equal(display(['.docs-nav summary'], 1024), 'none', 'docs menu summary hidden at 1024px');
  assert.notEqual(display(['.toc'], 1280), 'none', 'TOC shown at 1280px');
  assert.equal(display(['.toc'], 1024), 'none', 'TOC hidden at 1024px');
  assert.notEqual(display(['.icon-btn', '.menu-btn'], 900), 'none', 'menu button shown at 900px');
  assert.match(js, /\.docs-nav details/, 'site.js runs the docs menu');
  assert.match(js, /\.toc a\[href/, 'site.js tracks the TOC links');
});

test('growing the window past 860px with focus on the docs menu summary does not drop focus to <body>', () => {
  const hiddenWide = display(['.docs-nav summary'], 1024) === 'none';
  const on860 = listeners.filter(l => crosses(l.query, 860) && l.query !== 'resize').map(l => l.body.replace(/\s+/g, ' '));
  assert.ok(!hiddenWide || returnsFocus(860),
    `site.css hides .docs-nav summary above 860px; site.js's listener on that width (${on860.join(' | ')}) moves focus ` +
    'nowhere and nothing watches focus leave. A keyboard user on "Docs menu" at 200% zoom who zooms back out is left with focus on <body>');
});

test('narrowing the window under 1181px with focus on an "On this page" link does not drop focus to <body>', () => {
  const hiddenNarrow = display(['.toc'], 1024) === 'none';
  assert.ok(!hiddenNarrow || returnsFocus(1180),
    'site.css hides .toc at 1180px and under, no site.js listener on that width moves focus, and nothing watches focus ' +
    'leave. A keyboard user on a TOC link who zooms in (Ctrl+plus on a 1280 to 1440px laptop) is left with focus on <body>');
});

test('growing the window past 1020px with focus on the closed menu button does not drop focus to <body>', () => {
  const btnHiddenWide = display(['.icon-btn', '.menu-btn'], 1280) === 'none';
  assert.ok(!btnHiddenWide || returnsFocus(1020),
    'site.css hides the menu button above 1020px; site.js\'s 1021px listener calls setMenu(false), which returns focus only ' +
    'when the menu contains it (`menu.contains(document.activeElement)`), and nothing watches focus leave, so a focused, ' +
    'closed menu button is hidden and focus falls to <body>');
});

