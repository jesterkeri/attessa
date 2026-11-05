// Adversary round 57 on the site (2be81cb..9418f4a). Intended home: site/test/focus-return-keeps-place.test.mjs
// Run from the repo root: node --test site/test/focus-return-keeps-place.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// Round 56 (resize-hidden-focus-returns.test.mjs) held that a width change which hides the focused control must
// not drop focus to <body>. site.js's document `focusout` listener now catches that and focuses "the docs menu's
// first link if it shows, else main": `const near = $('.docs-nav a'); (near?.getClientRects().length ? near :
// $('main'))?.focus();`. "Shows" there means only "has a box", not "is on screen". At 860px and under the docs
// menu is no longer sticky (site.css:971 `.docs-nav { position: static; ... }`), it sits at the top of the page
// and is open (partials/docs-nav.html:2 `<details open>`, and site.js:243 opens it again when the window is
// wider than 860px). So when the change lands at 860px or under, focus() on that first link, "Overview", scrolls
// the page back to the top: the reader, who was deep in the page, loses their place, and the next Tab goes on
// through the docs menu instead of the section they were reading.
//
// The ordinary paths: an iPad Pro 11" with a keyboard (1194x834, the TOC shows) turned to portrait (834x1194,
// README.md's 834 width), a 1280x800 tablet turned to 800x1280 or a 1280 laptop window snapped to half, with
// focus on an "On this page" link (site.css:968 hides .toc at 1180px and under) or on the header network chip
// (site.css:139 hides .net-chip at 1180px and under).
//
// Measured on the built pages (adv-site-r57 worktree at 9418f4a, dist as built), headless Chromium
// (playwright-core, chrome-headless-shell 1243), 2026-11-05, every non-site request aborted (CDN failed; the
// same script runs when everything works), probe/tocjump.mjs beside this file: scroll 60% down, focus the last
// "On this page" link (sticky, on screen), set the viewport in one step, read scrollY and document.activeElement:
//   docs/reference.html cdnfail 1280x800 -> 800x1280:
//     before scrollY=6488 active=A.is-active "Refusal codes" top=212 bottom=242 vh=800
//     after  scrollY=0 active=A. "Overview" top=241 bottom=272 vh=1280
//     Tab    scrollY=0 active=A. "Pay-if-verified in 10 minutes "
//   docs/reference.html cdnfail 1194x834 -> 834x1194: scrollY 6691 -> 0, active "Overview"
//   docs/tutorial.html live 1280x800 -> 768x1024: scrollY 3604 -> 0, active "Overview"
//   docs/explanation.html cdnfail 1440x900 -> 720x900: scrollY 2792 -> 0, active "Overview"
// Control (probe/mainfocus.mjs): with the page scrolled deep, main.focus() keeps scrollY (6894 -> 6894 on
// docs/reference.html at 800x1280, 4669 -> 4669 on how-it-works.html at 1280x800), while focus() on the first
// docs-menu link moves it 6894 -> 0, and focus({ preventScroll: true }) on it leaves focus 6654px above the screen.
// Focus moved to a place far from where the reader was (WCAG 2.2 SC 2.4.3 Focus Order); the round brief asks
// whether the listener "scroll[s] the page or put[s] focus off screen", and it does one or the other.
//
// The test needs no browser. It takes the focusout listener out of site.js and runs it against a stub page in
// that state: viewport 800x1280 scrolled to 6488px, the focused TOC link now without a box, focus on <body>, the
// docs menu's first link with a box at the top of the page (6247px above the screen) and main spanning the
// screen. The stub models Chromium's focus() as the control above measured it: an element whose box meets the
// screen does not scroll the page, one that doesn't is brought on screen unless focus() gets preventScroll.
// It asserts that focus lands on an element on screen and the page did not move. Any fix passes that picks an
// on-screen target: main (it never scrolls here), the docs-menu link only when its box is on screen, or
// anything else in view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(src, 'static', 'assets', 'site.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const navHtml = readFileSync(join(src, 'partials', 'docs-nav.html'), 'utf8');

// The text of a balanced (...) group that opens at or after `from`.
function group(text, from) {
  const start = text.indexOf('(', from);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1);
  }
  return '';
}

// Every focusout, focusin and blur listener site.js puts on the document or the window.
const trackers = [...js.matchAll(/(?:document\.|window\.|\b)addEventListener\(\s*['"](focusout|focusin|blur)['"]/g)]
  .map(m => ({ type: m[1], args: group(js, m.index + m[0].indexOf('(')) }));

// The state measured above, 1280x800 turned to 800x1280 on docs/reference.html.
const VW = 800, VH = 1280, NAV_H = 68, PAGE_H = 10600;
function stubPage() {
  const view = { scrollY: 6488 };
  const focusLog = [];
  // An element with a box at document y [top, top + h); h = 0 means no box (display: none).
  const el = (name, top, h, extra = {}) => {
    const node = {
      name, nodeType: 1, isConnected: true, tabIndex: -1, ...extra,
      getClientRects() { return h ? [this.getBoundingClientRect()] : []; },
      getBoundingClientRect() {
        const t = h ? top - view.scrollY : 0;
        return { top: t, bottom: h ? t + h : 0, left: 0, right: h ? VW : 0, width: h ? VW : 0, height: h, x: 0, y: t };
      },
      get offsetParent() { return h ? doc.body : null; },
      get offsetHeight() { return h; },
      get offsetTop() { return top; },
      focus(opts = {}) {
        focusLog.push({ name, preventScroll: !!opts.preventScroll });
        if (!h) return;
        const r = this.getBoundingClientRect();
        const onScreen = r.bottom > 0 && r.top < VH;
        if (!onScreen && !opts.preventScroll) view.scrollY = Math.max(0, Math.min(PAGE_H - VH, top - NAV_H));
        doc.activeElement = node;
      },
      contains(o) { return o === node; },
      closest() { return null; },
      matches() { return false; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      hasAttribute() { return false; },
      getAttribute() { return null; },
      scrollIntoView() { view.scrollY = Math.max(0, top - NAV_H); },
    };
    return node;
  };
  const doc = { listeners: [] };
  doc.body = el('body', 0, PAGE_H, { tagName: 'BODY' });
  doc.documentElement = el('html', 0, PAGE_H, { tagName: 'HTML', clientHeight: VH, clientWidth: VW });
  const main = el('main', 120, PAGE_H - 600, { tagName: 'MAIN', id: 'main' });
  const firstNavLink = el('docs menu link "Overview"', 241, 31, { tagName: 'A' });
  const tocLink = el('TOC link "Refusal codes" (now display: none)', 0, 0, { tagName: 'A' });
  const known = {
    '.docs-nav a': firstNavLink, '.docs-nav-body a': firstNavLink, '.docs-nav details a': firstNavLink,
    main, '#main': main, 'main#main': main,
  };
  doc.querySelector = sel => known[sel.trim()] ?? null;
  doc.querySelectorAll = sel => (known[sel.trim()] ? [known[sel.trim()]] : []);
  doc.getElementById = id => (id === 'main' ? main : null);
  doc.addEventListener = (type, fn) => doc.listeners.push({ type, fn });
  doc.activeElement = doc.body;
  return { view, doc, focusLog, tocLink, main, firstNavLink };
}

function run(tracker) {
  const page = stubPage();
  const frames = [];
  const win = {
    get scrollY() { return page.view.scrollY; }, get pageYOffset() { return page.view.scrollY; },
    innerWidth: VW, innerHeight: VH,
    addEventListener: page.doc.addEventListener,
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    setTimeout: fn => { frames.push(fn); return frames.length; },
    queueMicrotask: fn => frames.push(fn),
    matchMedia: q => {
      const m = q.match(/\((min|max)-width:\s*([\d.]+)px\)/);
      return { matches: m ? (m[1] === 'min' ? VW >= Number(m[2]) : VW <= Number(m[2])) : false, addEventListener() {} };
    },
    getComputedStyle: () => ({ position: 'static', display: 'block', visibility: 'visible' }),
  };
  const env = {
    ...win, window: win, document: page.doc, root: page.doc.documentElement,
    $: (sel, scope = page.doc) => scope.querySelector(sel),
    $$: (sel, scope = page.doc) => [...scope.querySelectorAll(sel)],
    Element: Object, HTMLElement: Object, Node: Object,
  };
  // Run the listener's own registration with the stubs in scope, then fire focusout from the TOC link.
  // eslint-disable-next-line no-new-func
  new Function('env', `with (env) { addEventListener${tracker.args}; }`)(env);
  const listener = page.doc.listeners.find(l => l.type === tracker.type);
  assert.ok(listener, `site.js registers its ${tracker.type} listener`);
  listener.fn({ type: tracker.type, target: page.tocLink, relatedTarget: null });
  for (let i = 0; i < 20 && frames.length; i++) frames.shift()();
  return page;
}

test('precondition: at 860px and under the docs menu sits open at the top of the page, and the TOC is hidden', () => {
  assert.match(navHtml, /<details\s+open\b/, 'partials/docs-nav.html: the docs menu starts open');
  const narrow = [...css.matchAll(/@media\s*\(max-width:\s*860px\)\s*\{/g)].map(m => css.slice(m.index, m.index + 1500));
  assert.ok(narrow.some(b => /(?:^|[\s}])\.docs-nav\s*\{[^}]*position:\s*static/.test(b)),
    'site.css: under 861px the docs menu is position: static, so its first link scrolls away with the page');
  assert.ok(/@media\s*\(max-width:\s*1180px\)\s*\{[^@]*?\.toc\s*\{\s*display:\s*none/.test(css), 'site.css hides the TOC at 1180px and under');
  assert.ok(trackers.length > 0, 'site.js watches focus leave (round 56)');
});

test('when a width change hides the focused control, focus goes to something on screen and the page does not jump', () => {
  for (const tracker of trackers) {
    const page = run(tracker);
    const active = page.doc.activeElement;
    const r = active.getBoundingClientRect();
    const onScreen = active !== page.doc.body && r.bottom > NAV_H && r.top < VH;
    const where = `focus() calls: ${JSON.stringify(page.focusLog)}; scrollY 6488 -> ${page.view.scrollY}; ` +
      `focused ${active.name} at top=${r.top} bottom=${r.bottom} (screen 0 to ${VH})`;
    assert.ok(Math.abs(page.view.scrollY - 6488) < VH / 2,
      `the reader's place is lost: a TOC link hidden by turning a 1280x800 tablet to 800x1280 on docs/reference.html ` +
      `sends focus to the docs menu's first link at the top of the page and scrolls there. ${where}`);
    assert.ok(onScreen, `focus is put off screen or nowhere. ${where}`);
  }
});
