// Adversary round 58 on the site (2be81cb..1fd2c85). Intended home: site/test/focus-return-at-page-end.test.mjs
// Run from the repo root: node --test site/test/focus-return-at-page-end.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// Round 57 (focus-return-keeps-place.test.mjs) held that when a width change hides the focused control, focus
// must land on something on screen and the page must not jump. site.js's document `focusout` listener now
// focuses "the first tab stop in main that is fully on screen below the header ... else main, which doesn't
// scroll". Only main's stops are searched, and "main doesn't scroll" holds only while main covers the screen.
// The footer on every page is taller than the bottom 200 to 300px of the scroll range, so a reader at the end
// of a page has no stop of main on screen, main is wholly above the screen, and main.focus() scrolls the page
// to main's middle: thousands of pixels up, with focus on main, so the next Tab goes to main's first link at the
// top. The footer links and the network radio that are on screen are never considered.
//
// The ordinary path: at the bottom of any page, focus the header network chip ("Change the network in the
// footer", href="#network", which itself brings the reader to the footer) and narrow the window to 1180px or
// under (site.css:139 hides .net-chip), or focus the menu button under 1021px and widen the window.
//
// Measured on the built pages (adv-site-r58 worktree at 1fd2c85, dist as built), headless Chromium
// (playwright-core, chrome-headless-shell 1243), 2026-11-05, every non-site request aborted (CDN failed) or the
// CDN stubbed (live), probe/bottomjump.mjs beside this file: scroll to the bottom, focus the control, set the
// viewport in one step, read scrollY and document.activeElement after the listener ran:
//   index.html          cdnfail 1440x900 -> 1024x900, .net-chip: scrollY 10387 -> 4354, active MAIN top=-4354
//   how-it-works.html   cdnfail 1440x900 -> 1024x900, .net-chip: scrollY  7563 -> 3078, active MAIN
//   use-cases.html      cdnfail 1440x900 -> 1024x900, .net-chip: scrollY  4483 -> 1491, active MAIN
//   explorer.html       cdnfail 1440x900 -> 1024x900, .net-chip: scrollY  3456 -> 1163, active MAIN
//   security.html       cdnfail 1440x900 -> 1024x900, .net-chip: scrollY  3016 ->  925, active MAIN
//   privacy.html        cdnfail 1440x900 -> 1024x900, .net-chip: scrollY  1489 ->  114, active MAIN
//   docs/index.html     cdnfail 1440x900 -> 1024x900, .net-chip: scrollY  1904 ->  317, active MAIN
//   docs/reference.html cdnfail 1440x900 -> 1024x900, .net-chip: scrollY 10127 -> 4366, active MAIN
//   docs/how-to.html    cdnfail 1366x768 -> 1180x768, .net-chip: scrollY  3602 -> 1184, active MAIN
//   index.html          live 1000x800 -> 1280x800, .menu-btn:    scrollY 16527 -> 7801, active MAIN
//   docs/tutorial.html  live 1000x800 -> 1280x800, .menu-btn:    scrollY  5063 -> 2023, active MAIN
// probe/pickscan.mjs (the listener's own choice run at 31 scroll positions per page) shows the same jump on
// index, how-it-works and use-cases at 390x844 and 1440x900, in both the CDN-failed and live states, at every
// position where no stop of main is fully on screen. Focus moved far from where the reader was and the page
// jumped (WCAG 2.2 SC 2.4.3 Focus Order; the round brief: "does focusing it scroll the page anyway", "the case
// where no stop is fully on screen").
//
// The test needs no browser. It takes the focusout listener out of site.js and runs it against a stub page in
// the measured state of index.html at 1024x900 at the bottom (probe/bottomlayout.mjs): scrollY 9876, page
// 10776px, header fixed 0..68, main 0..9676 with its 14 stops, the last at 9503..9553, the footer 9676..10775
// with nine links at 10029..10175 and the network radios (Sepolia checked, mainnet disabled). The net chip lost
// its box and focus is on <body>. The stub models Chromium's focus() as round 57 did and as measured above: an
// element whose box meets the screen does not scroll the page; one that doesn't is centred unless focus() gets
// preventScroll; a disabled control or one without a box takes no focus. It asserts that focus lands on an
// element whose box is on screen and that the page did not move. Any fix passes that picks a stop on screen
// anywhere on the page (a footer link, the checked radio, a header link).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(src, 'static', 'assets', 'site.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

// A small selector matcher: lists, descendant combinators, tag, #id, .class, [attr], [attr="v"], :not(...).
function splitTop(s, sep) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && sep.test(ch)) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function matchCompound(el, c) {
  const re = /^(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~|^$*]?=)["']?([^"'\]]*)["']?)?\]|:not\(((?:[^()]|\([^()]*\))*)\)|:([\w-]+)/y;
  let i = 0;
  while (i < c.length) {
    re.lastIndex = i;
    const m = re.exec(c);
    if (!m) throw new Error(`stub selector parser: cannot read "${c}" at ${i}`);
    i = re.lastIndex;
    if (m[1] && m[1] !== '*' && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    if (m[2] && el.id !== m[2]) return false;
    if (m[3] && !el.classList.contains(m[3])) return false;
    if (m[4]) {
      const v = el.getAttribute(m[4]);
      if (v == null) return false;
      if (m[5] === '=' && v !== m[6]) return false;
      if (m[5] === '^=' && !v.startsWith(m[6])) return false;
    }
    if (m[7] !== undefined && splitTop(m[7], /,/).some(s => matchCompound(el, s))) return false;
    if (m[8] === 'disabled' && !el.disabled) return false;
    if (m[8] === 'checked' && !el.checked) return false;
  }
  return true;
}
function matchComplex(el, sel) {
  const parts = splitTop(sel, /\s/).filter(p => p !== '>');
  if (!matchCompound(el, parts.at(-1))) return false;
  let a = el.parentElement;
  for (let k = parts.length - 2; k >= 0; k--) {
    while (a && !matchCompound(a, parts[k])) a = a.parentElement;
    if (!a) return false;
    a = a.parentElement;
  }
  return true;
}
const matches = (el, sel) => splitTop(sel, /,/).some(s => matchComplex(el, s));

// The measured state of index.html at 1024x900 at the bottom of the page (see the header).
const VW = 1024, VH = 900, NAV_H = 68, PAGE_H = 10776, START_Y = 9876;
function stubPage(extra) {
  const view = { scrollY: START_Y };
  const focusLog = [];
  const doc = { listeners: [], nodeType: 9 };
  const all = [];
  // An element with a box at document y [top, top + h) (fixed: at screen y [top, top + h)); h = 0: no box.
  const el = (tag, top, h, attrs = {}, parent = null, opts = {}) => {
    const node = {
      tagName: tag.toUpperCase(), nodeName: tag.toUpperCase(), nodeType: 1, isConnected: true, children: [],
      parentElement: parent, parentNode: parent ?? doc, id: attrs.id ?? '', attrs: { ...attrs },
      disabled: 'disabled' in attrs, checked: 'checked' in attrs, inert: false, hidden: false,
      name: opts.name ?? tag,
      get className() { return this.attrs.class ?? ''; },
      classList: { contains: c => (attrs.class ?? '').split(/\s+/).includes(c) },
      get tabIndex() {
        if ('tabindex' in this.attrs) return Number(this.attrs.tabindex);
        return /^(A|BUTTON|INPUT|SELECT|SUMMARY|TEXTAREA)$/.test(this.tagName) && (this.tagName !== 'A' || 'href' in this.attrs) ? 0 : -1;
      },
      getAttribute(n) { return n in this.attrs ? String(this.attrs[n]) : null; },
      hasAttribute(n) { return n in this.attrs; },
      getClientRects() { return h ? [this.getBoundingClientRect()] : []; },
      getBoundingClientRect() {
        const t = h ? (opts.fixed ? top : top - view.scrollY) : 0;
        const left = h ? (opts.left ?? 0) : 0, width = h ? (opts.width ?? VW) : 0;
        return { top: t, bottom: h ? t + h : 0, left, right: left + width, width, height: h, x: left, y: t };
      },
      checkVisibility() { return h > 0; },
      get offsetParent() { return h ? doc.body : null; },
      get offsetHeight() { return h; },
      get offsetWidth() { return h ? (opts.width ?? VW) : 0; },
      get offsetTop() { return top; },
      focus(o = {}) {
        focusLog.push({ name: node.name, preventScroll: !!o.preventScroll });
        if (!h || node.disabled || node.tabIndex < -1) return;
        if (node.tagName !== 'MAIN' && !('tabindex' in node.attrs) && node.tabIndex < 0) return;
        const r = node.getBoundingClientRect();
        const meets = r.bottom > 0 && r.top < VH;
        if (!meets && !o.preventScroll && !opts.fixed) {
          view.scrollY = Math.max(0, Math.min(PAGE_H - VH, Math.round(top + h / 2 - VH / 2)));
        }
        doc.activeElement = node;
      },
      blur() { if (doc.activeElement === node) doc.activeElement = doc.body; },
      contains(o) { for (let a = o; a; a = a.parentElement) if (a === node) return true; return false; },
      closest(sel) { for (let a = node; a; a = a.parentElement) if (matches(a, sel)) return a; return null; },
      matches(sel) { return matches(node, sel); },
      querySelectorAll(sel) { return all.filter(e => e !== node && node.contains(e) && matches(e, sel)); },
      querySelector(sel) { return node.querySelectorAll(sel)[0] ?? null; },
      scrollIntoView() { if (!opts.fixed) view.scrollY = Math.max(0, Math.min(PAGE_H - VH, top - NAV_H)); },
    };
    if (parent) parent.children.push(node);
    all.push(node);
    return node;
  };
  const html = el('html', 0, PAGE_H);
  html.clientHeight = VH; html.clientWidth = VW;
  const body = el('body', 0, PAGE_H, {}, html);
  const navWrap = el('div', 0, NAV_H, { class: 'nav-wrap' }, body, { fixed: true });
  const header = el('header', 0, NAV_H, { class: 'nav' }, navWrap, { fixed: true });
  el('a', 20, 28, { class: 'brand', href: 'index.html' }, header, { fixed: true, left: 24, width: 120, name: 'header link "Attessa"' });
  const netChip = el('a', 0, 0, { class: 'net-chip', href: '#network' }, header, { name: 'net chip (now display: none)' });
  el('button', 0, 0, { class: 'icon-btn menu-btn', type: 'button' }, header, { name: 'menu button (display: none)' });
  const main = el('main', 0, 9676, { id: 'main', tabindex: '-1' }, body, { name: 'main' });
  for (let i = 0; i < 13; i++) el('a', 300 + i * 700, 44, { class: 'btn', href: `#s${i}` }, main, { name: `main stop ${i + 1}` });
  el('a', 9503, 50, { class: 'btn', href: 'explorer.html' }, main, { name: 'main stop 14 (the last)' });
  const footer = el('footer', 9676, 1099, { class: 'foot' }, body);
  extra?.(el, footer);
  const fl = (href, top) => el('a', top, 29, { href }, footer, { name: `footer link ${href}` });
  fl('https://github.com/jesterkeri/attessa', 10029); fl('how-it-works.html', 10029); fl('use-cases.html', 10058);
  fl('docs/index.html', 10058); fl('explorer.html', 10088); fl('security.html', 10088); fl('privacy.html', 10117);
  fl('terms.html', 10117); fl('.well-known/security.txt', 10146);
  el('input', 10073, 15, { type: 'radio', name: 'network', value: 'sepolia', checked: '' }, footer, { name: 'network radio Sepolia (checked)' });
  el('input', 10130, 15, { type: 'radio', name: 'network', value: 'mainnet', disabled: '' }, footer, { name: 'network radio mainnet (disabled)' });

  doc.documentElement = html; doc.body = body; doc.scrollingElement = html;
  doc.querySelectorAll = sel => all.filter(e => matches(e, sel));
  doc.querySelector = sel => doc.querySelectorAll(sel)[0] ?? null;
  doc.getElementById = id => all.find(e => e.id === id) ?? null;
  doc.contains = o => o === doc || html.contains(o);
  doc.elementFromPoint = (x, y) => {
    let hit = null;
    for (const e of all) { const r = e.getBoundingClientRect(); if (r.height && x >= r.left && x < r.right && y >= r.top && y < r.bottom) hit = e; }
    return y < NAV_H ? ([...all].reverse().find(e => header.contains(e) && e.getBoundingClientRect().height && y >= e.getBoundingClientRect().top && y < e.getBoundingClientRect().bottom && x >= e.getBoundingClientRect().left && x < e.getBoundingClientRect().right) ?? header) : hit;
  };
  doc.addEventListener = (type, fn) => doc.listeners.push({ type, fn });
  doc.activeElement = body;
  return { view, doc, focusLog, netChip, main, header };
}

function run(tracker, extra) {
  const page = stubPage(extra);
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
    getComputedStyle: e => ({ position: e?.className?.includes('nav-wrap') ? 'fixed' : 'static', display: 'block', visibility: 'visible', opacity: '1' }),
  };
  const env = {
    ...win, window: win, document: page.doc, root: page.doc.documentElement,
    $: (sel, scope = page.doc) => scope.querySelector(sel),
    $$: (sel, scope = page.doc) => [...scope.querySelectorAll(sel)],
    Element: Object, HTMLElement: Object, Node: Object,
  };
  // Run the listener's own registration with the stubs in scope, then fire focusout from the net chip.
  // eslint-disable-next-line no-new-func
  new Function('env', `with (env) { addEventListener${tracker.args}; }`)(env);
  const listener = page.doc.listeners.find(l => l.type === tracker.type);
  assert.ok(listener, `site.js registers its ${tracker.type} listener`);
  listener.fn({ type: tracker.type, target: page.netChip, relatedTarget: null });
  for (let i = 0; i < 20 && frames.length; i++) frames.shift()();
  return page;
}

test('precondition: the header network chip is hidden at 1180px and under, and site.js returns lost focus', () => {
  assert.ok(/@media\s*\(max-width:\s*1180px\)\s*\{\s*\.net-chip\s*\{\s*display:\s*none/.test(css), 'site.css hides .net-chip at 1180px and under');
  assert.ok(trackers.length > 0, 'site.js watches focus leave (rounds 56 and 57)');
});

test('at the end of a page, focus returned after a width change stays on screen and the page does not jump', () => {
  for (const tracker of trackers) {
    const page = run(tracker);
    const active = page.doc.activeElement;
    const r = active.getBoundingClientRect();
    const onScreen = active !== page.doc.body && r.height > 0 && r.bottom > 0 && r.top < VH;
    const where = `focus() calls: ${JSON.stringify(page.focusLog)}; scrollY ${START_Y} -> ${page.view.scrollY}; ` +
      `focused ${active.name} at top=${r.top} bottom=${r.bottom} (screen 0 to ${VH})`;
    assert.ok(Math.abs(page.view.scrollY - START_Y) < VH / 2,
      `the reader's place is lost: at the bottom of index.html, the header network chip hidden by narrowing ` +
      `1440x900 to 1024x900 sends focus to main, which is wholly above the screen, and the page jumps to its middle. ${where}`);
    assert.ok(onScreen, `focus is put off screen or nowhere. ${where}`);
  }
});

// Codex site review r1 m1: a roving-tabindex control (how-it-works.html's Buyer/Seller tabs, the one not selected
// has tabIndex -1) can be the first visible candidate. It takes focus programmatically but is not a tab stop, so
// the fallback must pass over it to the next stop in the keyboard order.
test('the fallback never returns focus to a visible control that is not a tab stop (tabindex -1)', () => {
  for (const tracker of trackers) {
    const page = run(tracker, (el, footer) =>
      el('button', 10000, 30, { type: 'button', role: 'tab', tabindex: '-1' }, footer, { name: 'roving tab not selected (tabindex -1)' }));
    const active = page.doc.activeElement;
    assert.ok(active.tabIndex >= 0, `focus went to ${active.name}, which is not a tab stop; focus() calls: ${JSON.stringify(page.focusLog)}`);
    assert.ok(Math.abs(page.view.scrollY - START_Y) < VH / 2, 'the page jumped');
  }
});
