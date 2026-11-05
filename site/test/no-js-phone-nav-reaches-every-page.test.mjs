// Adversary round 43 on the site (2be81cb1..71f672a). Intended home: site/test/no-js-phone-nav-reaches-every-page.test.mjs
// Run from the repo root: node --test site/test/no-js-phone-nav-reaches-every-page.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// site.js:1 promises "Everything degrades to readable static HTML without it", and site/README.md:109 says
// the site was checked at 390, 768, 834, 1024, 1280, 1366 and 1440px wide. Under 1021px the main nav is
// replaced by a menu button (site.css:166 to 169: `.nav-links { display: none }`, `.icon-btn` shown). The
// menu it opens is `<div class="menu" id="menu" hidden>` (layout.html), and only site.js's setMenu() ever
// clears that `hidden`; no site.css rule shows .nav-links or .menu without JavaScript (the no-js rules are
// site.css:644, :678 and :705 only). So without JavaScript, at 390, 768 and 834px:
//   - the "Open menu" button is visible, focusable and announced as a collapsed menu, and does nothing;
//   - the only site links left in the page chrome are the footer's (Docs, Explorer, Security, Privacy,
//     Terms, security.txt), and How it works and Use cases are in neither the footer nor any page body
//     except each other (use-cases.html:80 links How it works; nothing links Use cases).
// Result: from the home page, How it works and Use cases cannot be reached at all at phone and tablet widths
// without JavaScript. At 1024px and wider the nav row shows and every page is reachable.
// Measured on the built pages (site/dist at 71f672a), headless Chromium 1243 (playwright-core), 2026-11-05,
// every non-site request aborted: probe/reach.mjs in this round's scratch folder crawls only links with a
// rendered box and prints
//   == nojs 390x844: menu button visible true; after click {"menuHidden":true,"expanded":"false","label":"Open menu"}; unreachable: how-it-works.html, use-cases.html
//   == nojs 768x1024: ... unreachable: how-it-works.html, use-cases.html
//   == nojs 834x1112: ... unreachable: how-it-works.html, use-cases.html
//   == nojs 1024x768: menu button visible false; ... unreachable: none
//
// The test needs no browser. It assembles each page from layout.html, the page and its partials as
// build.mjs does, decides from site.css which link groups a no-JavaScript visitor can see at each width
// (the main nav row, the #menu panel), and walks the visible links from index.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(src, 'static', 'assets', 'site.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const layout = readFileSync(join(src, 'layout.html'), 'utf8');
const pagesDir = join(src, 'pages');
const pageFiles = dir => readdirSync(join(pagesDir, dir), { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? pageFiles(posix.join(dir, e.name)) : e.name.endsWith('.html') ? [posix.join(dir, e.name)] : []));
const PAGES = pageFiles('');

// build.mjs: {{> name}} is a partial, {{root}} the way back to the site root, {{cur:x}} aria-current.
function assemble(name) {
  const raw = readFileSync(join(pagesDir, name), 'utf8');
  const body = raw.replace(/^<!--\s*\w+:.*?-->\s*\r?\n/gm, '')
    .replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, p) => readFileSync(join(src, 'partials', `${p}.html`), 'utf8'));
  const root = '../'.repeat(name.split('/').length - 1);
  return layout.replace('{{content}}', () => body).replace(/\{\{root\}\}/g, root).replace(/\{\{cur:\w+\}\}/g, '');
}

// Elements with their parents, from a tag stack.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
function elements(html) {
  const out = [], stack = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  for (const m of clean.matchAll(/<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g)) {
    const [whole, tagRaw, attrText, selfClose] = m;
    const tag = tagRaw.toLowerCase();
    if (whole.startsWith('</')) { const i = stack.map(e => e.tag).lastIndexOf(tag); if (i >= 0) stack.length = i; continue; }
    const attrs = {};
    for (const a of attrText.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    const el = { tag, attrs, classes: new Set((attrs.class ?? '').split(/\s+/).filter(Boolean)), parent: stack.at(-1) ?? null };
    out.push(el);
    if (!VOID.has(tag) && !selfClose) stack.push(el);
  }
  return out;
}
const ancestors = el => { const a = []; for (let p = el.parent; p; p = p.parent) a.push(p); return a; };

// site.css rules with their media queries.
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
      else if (!prelude.startsWith('@')) {
        const display = inner.match(/(?:^|;)\s*display\s*:\s*([^;!]+)/)?.[1].trim();
        for (const sel of prelude.split(',')) out.push({ sel: sel.trim(), media, display });
      }
      i = j;
    }
  };
  parse(text, []);
  return out;
}
const RULES = rules(css);
const mediaMatches = (list, width) => list.every(q => q.split(/\s+and\s+/).every(f => {
  const m = f.trim().match(/^\(\s*([\w-]+)\s*:\s*([^)]+?)\s*\)$/);
  if (!m) return false;
  const px = parseFloat(m[2]);
  if (m[1] === 'max-width') return width <= px;
  if (m[1] === 'min-width') return width >= px;
  if (m[1] === 'prefers-reduced-motion') return m[2] === 'no-preference';
  return true; // height, hover, pointer: not width-dependent for this question
}));

// Can a visitor with no JavaScript see the links inside the element matched by `name` (".nav-links", ".menu")?
// Hidden when a matching rule at this width says display: none, or (for the menu) when it ships with the
// hidden attribute; shown again only by a rule that applies without JavaScript (.no-js or :target) and sets
// another display.
function visibleWithoutJs(el, name, width) {
  const targets = s => s.includes(name) || (el.attrs.id && s.includes(`#${el.attrs.id}`));
  const restoring = RULES.some(r => targets(r.sel) && /\.no-js|:target/.test(r.sel) && !/:not\(\.no-js\)/.test(r.sel)
    && r.display && r.display !== 'none' && mediaMatches(r.media, width));
  if (restoring) return true;
  if ('hidden' in el.attrs) return false;
  const hiding = RULES.some(r => r.sel === name && r.display === 'none' && r.media.length && mediaMatches(r.media, width));
  return !hiding;
}

function visibleLinks(name, width) {
  const els = elements(assemble(name));
  const html = els.find(e => e.tag === 'html');
  assert.ok(html?.classes.has('no-js'), 'precondition: layout.html ships <html class="no-js">');
  const groups = [['.nav-links', els.find(e => e.classes.has('nav-links'))], ['.menu', els.find(e => e.attrs.id === 'menu')]];
  for (const [g, el] of groups) assert.ok(el, `precondition: layout.html has the ${g} link group`);
  const hidden = groups.filter(([g, el]) => !visibleWithoutJs(el, g, width)).map(([, el]) => el);
  const out = new Set();
  for (const a of els.filter(e => e.tag === 'a' && e.attrs.href)) {
    const anc = ancestors(a);
    if (anc.some(p => 'hidden' in p.attrs || hidden.includes(p)) || 'hidden' in a.attrs) continue;
    const href = a.attrs.href.split('#')[0].split('?')[0];
    if (!href || /^[a-z]+:/i.test(href)) continue;
    let target = posix.normalize(posix.join(posix.dirname(name), href));
    if (target.endsWith('/')) target += 'index.html';
    if (PAGES.includes(target)) out.add(target);
  }
  return out;
}

function reachable(width) {
  const seen = new Set(['index.html']), queue = ['index.html'];
  while (queue.length) for (const t of visibleLinks(queue.shift(), width)) if (!seen.has(t)) { seen.add(t); queue.push(t); }
  return seen;
}

test('precondition: the site has How it works and Use cases pages, and the nav links both', () => {
  for (const p of ['how-it-works.html', 'use-cases.html']) assert.ok(PAGES.includes(p), `src/pages/${p} exists`);
  assert.match(layout, /class="nav-links"[\s\S]*how-it-works\.html[\s\S]*use-cases\.html/, 'the main nav links How it works and Use cases');
});

test('control: at 1440px without JavaScript the nav row shows and every page is reachable from the home page', () => {
  const seen = reachable(1440);
  assert.deepEqual(PAGES.filter(p => !seen.has(p)), []);
});

// README.md:109: the widths the site was checked at, below the 1021px nav breakpoint.
for (const width of [390, 768, 834]) {
  test(`without JavaScript at ${width}px, every page can be reached from the home page by a visible link`, () => {
    const seen = reachable(width);
    const missing = PAGES.filter(p => !seen.has(p));
    assert.deepEqual(missing, [],
      `without JavaScript at ${width}px the nav row is display: none and the #menu panel stays [hidden] (only site.js opens it, ` +
      `so the "Open menu" button does nothing); the footer and page bodies never link ${missing.join(' or ')}, so a visitor ` +
      `cannot reach ${missing.length === 1 ? 'it' : 'them'} (site.js:1: "Everything degrades to readable static HTML without it")`);
  });
}
