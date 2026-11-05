// Adversary round 45 on the site (2be81cb1..08dd4a6). Intended home: site/test/menu-close-keeps-focus.test.mjs
// Run from the repo root: node --test site/test/menu-close-keeps-focus.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// Under 1021px the nav is a menu button (site.css:166 to 169, README "The nav collapses to a menu under
// 1020px"; a 1920px window at 200% zoom is 960px wide, so keyboard and magnifier users get it on desktops
// too). site.js closes the open menu four ways. Two of them put focus somewhere visible: Escape
// (`setMenu(false); menuBtn.focus();`) and the menu button itself (focus never left it). The other two
// hide the menu while focus is on one of its links and move focus nowhere, so it drops to <body>:
//   - a click on a menu link that does not leave the page: Ctrl+Enter or Ctrl+click (Cmd on macOS) opens
//     the link in a background tab, the click handler `menu?.addEventListener('click', e => { if
//     (e.target.closest('a')) setMenu(false); })` still closes the menu, and the user stays on the page with
//     focus on nothing;
//   - the window growing past 1020px (zooming back out, rotating a tablet), `matchMedia('(min-width:
//     1021px)')` -> setMenu(false).
// setMenu(false) itself only clears inert and hides the menu; it never returns focus.
// Measured on the built pages (site/dist at 08dd4a6), headless Chromium 1243 (playwright-core),
// 2026-11-05, explorer.html at 390x844, JavaScript on with every third-party request aborted
// (probe/menuclose.mjs in this round's scratch folder: focus the menu button, Enter, then close):
//   escape:    active=BUTTON.icon-btn menu-btn "Open menu" visible=true menuOpen=false
//   ctrlenter: new tab opened: http://site.test/how-it-works.html
//              active=BODY.explorer-page visible=false menuOpen=false mainInert=false
//              then Tab: active=INPUT (the explorer search box, skipping the skip link, brand and menu button)
//   resize:    (to 1440x900) active=BODY.explorer-page visible=false menuOpen=false
// With focus on <body> a screen reader announces the document again and the user has lost their place
// (WCAG 2.2 SC 2.4.3 Focus Order). The same handlers run on every page (layout.html), with or without the
// CDN imports, since site.js has no dependencies.
//
// The test needs no browser. It reads site.js and asserts that each way of closing the menu while focus
// may be inside it either returns focus (a `.focus(` call in the handler, or setMenu(false) itself focusing
// when it closes) or, for the link click, leaves modified clicks alone so the menu stays open with focus on
// the link. Above 1020px the target must be something other than the menu button, which is hidden there.
// Any of those fixes passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
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

const setMenuAt = js.search(/const\s+setMenu\s*=/);
const setMenuBody = setMenuAt >= 0 ? group(js, js.indexOf('=>', setMenuAt), '{') : '';
// setMenu returns focus when closing if it has a focus call other than the "first link on open" one.
const setMenuFocusesOnClose = /\.focus\s*\(/.test(setMenuBody.replace(/if\s*\(\s*open\s*\)[^;]*\.focus\s*\([^;]*;/g, ''));

const linkClose = (() => {
  const at = js.search(/\bmenu\??\.addEventListener\(\s*['"]click['"]/);
  return at >= 0 ? group(js, at) : '';
})();
const resizeClose = (() => {
  const at = js.search(/matchMedia\(\s*['"]\(min-width:\s*1021px\)['"]\s*\)\s*\.addEventListener/);
  return at >= 0 ? group(js, js.indexOf('addEventListener', at)) : '';
})();

test('precondition: setMenu(false) hides the menu, a menu link click and growing past 1020px both close it', () => {
  assert.ok(setMenuBody, 'site.js defines setMenu');
  assert.match(setMenuBody, /menu\.hidden\s*=\s*!open/, 'setMenu hides the menu when closing');
  assert.match(linkClose, /closest\(\s*['"]a['"]\s*\)[\s\S]*setMenu\(\s*false\s*\)/, 'a click on a menu link closes the menu');
  assert.match(resizeClose, /setMenu\(\s*false\s*\)/, 'the 1021px media query closes the menu');
});

test('a menu link opened in a new tab (Ctrl+Enter, Ctrl or Cmd+click) does not leave focus on the hidden menu', () => {
  const returnsFocus = setMenuFocusesOnClose || /\.focus\s*\(/.test(linkClose);
  const skipsModified = /\b(?:ctrlKey|metaKey)\b/.test(linkClose);
  assert.ok(returnsFocus || skipsModified,
    `site.js closes the menu on any click on one of its links (${linkClose.replace(/\s+/g, ' ')}) and moves focus nowhere, ` +
    'and setMenu(false) does not return it. A Ctrl+Enter or Ctrl+click opens the link in a background tab and keeps the ' +
    'user on the page, so the menu link that had focus is hidden and focus falls to <body>');
});

// Above 1020px the menu button is display: none (site.css:147 `.icon-btn { display: none; ... }`, shown only
// under 1021px at site.css:168), so focusing it there does nothing: the resize close needs another target.
const focusesOtherThanButton = text => /(?<!menuBtn\??)\.focus\s*\(/.test(text);

test('growing the window past 1020px with the menu open does not leave focus on the hidden menu', () => {
  const setMenuOnClose = setMenuBody.replace(/if\s*\(\s*open\s*\)[^;]*\.focus\s*\([^;]*;/g, '');
  const returnsFocus = focusesOtherThanButton(setMenuOnClose) || focusesOtherThanButton(resizeClose);
  assert.ok(returnsFocus,
    `site.js closes the menu above 1020px (${resizeClose.replace(/\s+/g, ' ')}) and moves focus nowhere visible, and ` +
    'setMenu(false) does not return it (the menu button is display: none above 1020px, so it cannot take focus there), ' +
    'so a focused menu link is hidden and focus falls to <body>');
});
