// Adversary round 55 on the site (2be81cb..cbd032b). Intended home: packages/site/test/docs-menu-reopens-when-wide.test.mjs
// Run from the repo root: node --test packages/site/test/docs-menu-reopens-when-wide.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The docs menu is a <details open> (partials/docs-nav.html:2). Its summary, the only control that opens it, is
// hidden on wider screens: site.css:900 `.docs-nav summary { display: none; ... }`, and shown only inside
// site.css:969 `@media (max-width: 860px)` (site.css:972 `display: flex`). README.md:108 says "the docs menu
// becomes a toggle under 860px", so wider than that it is always there. But site.js:228 closes it once, at load:
// `if (docsNav && matchMedia('(max-width: 760px)').matches) docsNav.open = false;`, and nothing in site.js
// opens it again when the window grows past 860px. A closed <details> shows only its summary; with the summary
// hidden, the whole menu is gone, and nothing on screen or in the Tab order can bring it back short of a reload.
//
// That is the ordinary path for the people README.md and earlier rounds hold the site to: a laptop at 200% zoom
// (1440x900 lays out at 720x450, under 760px) opens a docs page, then goes back to 100%; an iPad mini (744px
// portrait) opens a docs page, then turns to landscape (1133px); a narrow browser window is maximised.
//
// Measured on the built pages (adv-site-r55 worktree at cbd032b, dist as built), headless Chromium
// (playwright-core, chrome-headless-shell 1243), 2026-11-05, every non-site request aborted, docs/reference.html
// (probe/docsrotate.mjs beside this file: load at one viewport, setViewportSize to another, Tab from the top):
//   live (stub three, scene-live), loaded 720x450, resized to 1440x900:
//     details.open=false summary=none navBox=6px; first docs-menu stop by Tab: never
//   cdnfail, loaded 744x1133, resized to 1133x744: the same, details.open=false summary=none navBox=6px, never
//   control, live, loaded 1440x900, resized to 720x450: details.open=true, Tab 4 reaches SUMMARY "Docs menu"
// Screenshot probe/zoom-1440-before-tab.png: the left column where the docs menu sits is empty; the page's own
// "On this page" TOC is there, the docs menu and its 15 links are not.
//
// The test needs no browser. It reads the CSS that shows or hides the docs-menu summary (the round 54 cascade
// harness), the load-time close in site.js, and every matchMedia change listener and resize listener in
// site.js, which it runs against a stub of the page at the new width to see whether any of them opens the menu
// again. For each width a page can load at (README.md's 390 to 834px, and 200% zoom on its 1280, 1366 and
// 1440px laptops) and each desktop width it can then grow to (1024, 1280, 1366, 1440px) it asks: is the menu
// closed, its summary hidden, and nothing opened it again? Any fix passes: do not close it, open it again from
// a listener when the summary hides, keep the summary shown, or show the closed details' content in CSS
// (`::details-content { content-visibility: visible }`) where the summary is hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(src, 'static', 'assets', 'site.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const navHtml = readFileSync(join(src, 'partials', 'docs-nav.html'), 'utf8');

// Split on a separator at depth 0 of () and [].
function splitTop(s, sep) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sep && !depth) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

// Style rules in source order, each with the @media preludes around it.
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
        const decls = [];
        for (const d of splitTop(inner, ';')) {
          const k = d.indexOf(':');
          if (k < 0) continue;
          decls.push([d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).replace(/!important\s*$/, '').trim()]);
        }
        out.push({ sels: splitTop(prelude, ',').map(s => s.trim().replace(/\s+/g, ' ')), media, decls });
      }
      i = j;
    }
  };
  parse(text, []);
  return out;
}

// A media query at CSS width w (a desktop with a mouse, height large). Width features in both syntaxes,
// `not all and`, `screen and`, comma lists. Anything else is undefined, so the test says so.
function mq(query, w) {
  const parts = splitTop(query, ',').map(s => s.trim());
  if (parts.length > 1) { const r = parts.map(p => mq(p, w)); return r.includes(undefined) ? undefined : r.some(Boolean); }
  let q = parts[0];
  let negate = false;
  const not = q.match(/^not\s+(?:all|screen)\s+and\s+/i);
  if (not) { negate = true; q = q.slice(not[0].length); }
  q = q.replace(/^(?:only\s+)?(?:all|screen)\s+and\s+/i, '');
  let ok = true;
  for (const c of q.split(/\s+and\s+/i)) {
    let m;
    if ((m = c.match(/^\(\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)$/i))) { const n = Number(m[2]); ok &&= m[1].toLowerCase() === 'min' ? w >= n : w <= n; }
    else if ((m = c.match(/^\(\s*width\s*(>=|<=|>|<)\s*([\d.]+)px\s*\)$/i))) { const n = Number(m[2]); ok &&= { '>=': w >= n, '<=': w <= n, '>': w > n, '<': w < n }[m[1]]; }
    else if ((m = c.match(/^\(\s*([\d.]+)px\s*(<=|<)\s*width\s*\)$/i))) { const n = Number(m[1]); ok &&= m[2] === '<' ? w > n : w >= n; }
    else if ((m = c.match(/^\(\s*(min|max)-height\s*:\s*([\d.]+)px\s*\)$/i))) ok &&= m[1].toLowerCase() === 'min';
    else if (/^\(\s*hover\s*:\s*hover\s*\)$/i.test(c) || /^\(\s*pointer\s*:\s*fine\s*\)$/i.test(c)) ok &&= true;
    else if (/^\(\s*pointer\s*:\s*coarse\s*\)$/i.test(c) || /^\(\s*hover\s*:\s*none\s*\)$/i.test(c)) ok = false;
    else if (/^\(\s*prefers-reduced-motion\s*:\s*\w[\w-]*\s*\)$/i.test(c)) ok &&= true;
    else return undefined;
  }
  return negate ? !ok : ok;
}
const on = (r, w) => {
  const v = r.media.map(q => mq(q, w));
  if (v.includes(undefined)) throw new Error(`unsupported media query: ${r.media.join(' and ')}`);
  return v.every(Boolean);
};

const all = rules(css);
// The docs-menu summary's display, by source order among the rules that name it (they share a specificity).
const summarySel = /^\.docs-nav (?:details ?>? ?)?summary$/;
const summaryRules = all.filter(r => r.sels.some(s => summarySel.test(s)) && r.decls.some(([p]) => p === 'display'));
function summaryShown(w) {
  let d = 'list-item';
  for (const r of summaryRules) if (on(r, w)) for (const [p, v] of r.decls) if (p === 'display') d = v;
  return d !== 'none';
}
// CSS that shows a closed details' content anyway (::details-content with content-visibility: visible).
const revealRules = all.filter(r => r.sels.some(s => /\.docs-nav\b.*::details-content/.test(s)) &&
  r.decls.some(([p, v]) => p === 'content-visibility' && v === 'visible'));
const contentShownClosed = w => revealRules.some(r => on(r, w));

// The balanced (...) group that opens at or after `from`.
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

// Load-time closes of the docs menu: `if (... matchMedia('Q').matches) X.open = false` (or removeAttribute('open')).
const loadCloses = [...js.matchAll(/matchMedia\(\s*(['"`])(.+?)\1\s*\)\.matches\s*\)\s*[\w$.?]*?(?:\.open\s*=\s*false|\.removeAttribute\(\s*['"]open['"]\s*\))/g)].map(m => m[2]);
const closesAtLoad = w => loadCloses.some(q => mq(q, w));

// Every change listener on a matchMedia query (inline or through a variable), and every window resize listener,
// as handler source.
const listeners = [];
for (const m of js.matchAll(/matchMedia\(\s*(['"`])(.+?)\1\s*\)\s*\.\s*addEventListener\(\s*['"]change['"]\s*,/g)) {
  const call = group(js, m.index + m[0].lastIndexOf('addEventListener') + 'addEventListener'.length);
  listeners.push({ kind: 'change', query: m[2], handler: call.slice(1, -1).replace(/^\s*['"]change['"]\s*,/, '').trim() });
}
for (const m of js.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*matchMedia\(\s*(['"`])(.+?)\2\s*\)/g)) {
  for (const n of js.matchAll(new RegExp(`\\b${m[1].replace('$', '\\$')}\\s*\\.\\s*addEventListener\\(\\s*['"]change['"]\\s*,`, 'g'))) {
    const call = group(js, n.index + n[0].lastIndexOf('addEventListener') + 'addEventListener'.length);
    listeners.push({ kind: 'change', query: m[3], handler: call.slice(1, -1).replace(/^\s*['"]change['"]\s*,/, '').trim() });
  }
}
for (const m of js.matchAll(/(?:^|[^\w$.])(?:window\s*\.\s*)?addEventListener\(\s*['"]resize['"]\s*,/g)) {
  const call = group(js, m.index + m[0].lastIndexOf('addEventListener') + 'addEventListener'.length);
  listeners.push({ kind: 'resize', handler: call.slice(1, -1).replace(/^\s*['"]resize['"]\s*,/, '').trim().replace(/,\s*\{[^{}]*\}\s*$/, '') });
}

// Run a handler against a stub page at width w and report whether it set some `.open` to a truthy value (or
// called setAttribute('open')). Every free name resolves to a stub that absorbs calls and property reads, except
// matchMedia, innerWidth and the event, which answer for width w.
function opensAt(handlerSrc, w, matches) {
  let opened = false;
  const stub = () => new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : k === Symbol.iterator ? function* () {} : k === 'then' ? undefined : stub()),
    set: (t, k, v) => { if (k === 'open' && v) opened = true; return true; },
    apply: (t, self, args) => stub(),
    has: () => true,
  });
  const scope = new Proxy({}, {
    has: (t, k) => typeof k === 'string' && !['undefined', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Set', 'Map', 'console'].includes(k),
    get: (t, k) => {
      if (k === Symbol.unscopables) return undefined;
      if (k === 'matchMedia') return q => ({ matches: Boolean(mq(q, w)), addEventListener() {}, removeEventListener() {} });
      if (k === 'innerWidth' || k === 'outerWidth') return w;
      if (k === 'requestAnimationFrame' || k === 'setTimeout') return f => { try { f(); } catch { /* stub page */ } return 0; };
      const s = stub();
      return k === 'docsNav' || /details|nav/i.test(k) ? new Proxy(s, { get: (o, p) => (p === 'setAttribute' ? (a => { if (a === 'open') opened = true; }) : p === 'open' ? false : Reflect.get(o, p)) }) : s;
    },
    set: () => true,
  });
  let fn;
  try { fn = new Function('scope', `with (scope) { return (${handlerSrc}); }`)(scope); } catch { return false; }
  try { fn({ matches, media: '', target: { matches } }); } catch { /* a stub cannot answer everything */ }
  return opened;
}

function reopenedGoing(w0, w1) {
  return listeners.some(l => {
    if (l.kind === 'change') {
      const a = mq(l.query, w0), b = mq(l.query, w1);
      if (a === undefined || b === undefined) throw new Error(`unsupported media query in site.js: ${l.query}`);
      return a !== b && opensAt(l.handler, w1, b);
    }
    return opensAt(l.handler, w1, false);
  });
}

// Where a page can be loaded (README.md's widths up to 834px, and 200% zoom on its 1280, 1366, 1440px laptops)
// and where it can then grow to (README.md's desktop widths).
const loadWidths = [390, 640, 683, 720, 744, 768, 834];
const grownWidths = [1024, 1280, 1366, 1440];

test('precondition: this test reads the docs menu, its summary and site.js the way the browser does', () => {
  assert.match(navHtml, /<details\s+open\b/, 'the docs menu is a <details open>');
  assert.ok(summaryRules.length >= 2, 'site.css hides and shows the docs-menu summary');
  assert.equal(summaryShown(390), true, 'the summary (the toggle) shows on a phone');
  assert.equal(summaryShown(1440), false, 'the summary is hidden on a desktop, where the menu is a column');
  assert.ok(listeners.some(l => l.kind === 'change' && /1021/.test(l.query)), 'this test finds site.js\'s change listeners');
  // The stub runner sees an opener when there is one.
  assert.equal(opensAt('e => { if (e.matches) docsNav.open = true; }', 1440, true), true, 'the stub runner detects an open');
  assert.equal(opensAt('e => { if (e.matches) setMenu(false); }', 1440, true), false, 'and does not invent one');
});

test('a docs menu closed at load comes back when the window grows to a desktop width', () => {
  const lost = [];
  for (const w0 of loadWidths) {
    if (!closesAtLoad(w0)) continue;
    for (const w1 of grownWidths) {
      if (summaryShown(w1) || contentShownClosed(w1) || reopenedGoing(w0, w1)) continue;
      lost.push(`loaded at ${w0}px, then ${w1}px`);
    }
  }
  assert.deepEqual(lost, [],
    `site.js closes the docs menu at load where matchMedia('${loadCloses.join("' / '")}') matches, and nothing ` +
    'opens it again, but over 860px site.css hides its summary (the only way to open it). At these sizes the ' +
    'docs menu and its links are gone from the page and from the Tab order until a reload');
});
