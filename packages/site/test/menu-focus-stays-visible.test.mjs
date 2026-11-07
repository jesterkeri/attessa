// Adversary round 44 on the site (2be81cb1..d3e87f0). Intended home: packages/site/test/menu-focus-stays-visible.test.mjs
// Run from the repo root: node --test packages/site/test/menu-focus-stays-visible.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// Under 1021px the nav is a menu button (site.css:166 to 169). With JavaScript on (also when the three.js and
// GSAP imports fail, since site.js has no dependencies) the button opens `#menu`, a full-screen panel:
// site.css `.menu { position: fixed; inset: 0; z-index: 35; ... background: rgba(3, 3, 4, 0.72);
// backdrop-filter: blur(28px) ... }`. site.js setMenu(true) only clears `hidden`, toggles `menu-open` and
// focuses the first menu link; the menu closes on Escape, on a menu link click, or above 1020px. Nothing
// keeps keyboard focus inside it: no `inert` on the page behind, no Tab handling, no focusin/focusout
// close, no modal <dialog>. In layout.html `#menu` sits right before `<main>`, so pressing Tab on the
// menu's last item ("Explorer preview") moves focus into the page under the panel, and the panel stays
// open. The focused element is then entirely hidden (WCAG 2.2 SC 2.4.11 Focus Not Obscured, AA), and
// every further Tab walks the page's links, the search box and its button out of sight.
// Measured on the built pages (packages/site/dist at d3e87f0), headless Chromium 1243 (playwright-core),
// 2026-11-05, 390x844, JavaScript on with every third-party request aborted (probe/menutab.mjs in this
// round's scratch folder: focus the menu button, Enter, then Tab):
//   tab 5: A "Explorer preview" box[28,669 202x50] inMenu=true menuOpen=true topAtCentre=A.btn btn-primary (menu)
//   tab 6: A "Explorer preview" box[59,623 202x50] inMenu=false menuOpen=true topAtCentre=DIV.menu (menu)
//   tab 7: A "Use it from your agent" box[59,683 228x50] inMenu=false menuOpen=true topAtCentre=A.btn btn-primary (menu)
//   tab 8: INPUT "" box[20,426 258x58] inMenu=false menuOpen=true topAtCentre=A. (menu)
//   tab 9: BUTTON "Check" box[292,436 77x39] inMenu=false menuOpen=true topAtCentre=A. (menu)
// (topAtCentre is document.elementFromPoint at the focused element's centre: the menu covers it.) A
// screenshot at tab 6 (probe/menushot.mjs) shows only the open menu; the focused hero link and its
// outline cannot be seen.
//
// The test needs no browser. It reads layout.html, site.css and site.js and asserts that if the open menu
// covers the whole viewport and comes before the page in the tab order, site.js keeps focus out of the
// covered page: the page made inert, Tab wrapped inside the menu, the menu closed when focus leaves it, or
// a modal dialog. Any of those fixes passes; so does a menu that no longer covers the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(src, 'static', 'assets', 'site.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const layout = readFileSync(join(src, 'layout.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const pagesDir = join(src, 'pages');
const pageFiles = dir => readdirSync(join(pagesDir, dir), { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? pageFiles(posix.join(dir, e.name)) : e.name.endsWith('.html') ? [posix.join(dir, e.name)] : []));
const PAGES = pageFiles('');

// build.mjs: {{> name}} is a partial.
const pageBody = name => readFileSync(join(pagesDir, name), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, p) => readFileSync(join(src, 'partials', `${p}.html`), 'utf8'));
const FOCUSABLE = /<(?:a\b[^>]*\shref=|button\b|input\b(?![^>]*type="hidden")|select\b|textarea\b|summary\b|[a-z]+\b[^>]*\stabindex="0")/g;

// Top-level (not inside @media) declarations of a plain selector.
function topRule(selector) {
  let depth = 0, out = {};
  const re = /([^{}]*)\{|\}/g;
  let m, pending = [];
  while ((m = re.exec(css))) {
    if (m[0] === '}') { depth--; continue; }
    const prelude = m[1].trim();
    if (prelude.startsWith('@')) { depth++; continue; }
    const end = css.indexOf('}', re.lastIndex);
    const body = css.slice(re.lastIndex, end);
    if (depth === 0 && prelude.split(',').map(s => s.trim()).includes(selector)) {
      for (const d of body.split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
    }
    re.lastIndex = end + 1;
  }
  return out;
}

test('precondition: the menu button opens #menu, which comes after the button and before <main> in the tab order', () => {
  const btn = layout.indexOf('class="icon-btn menu-btn"');
  const menu = layout.indexOf('id="menu"');
  const main = layout.indexOf('<main');
  assert.ok(btn > 0 && menu > btn && main > menu, `menu-btn at ${btn}, #menu at ${menu}, <main at ${main}`);
  assert.match(layout, /aria-controls="menu"/);
  const menuHtml = layout.slice(menu, main);
  assert.ok((menuHtml.match(FOCUSABLE) ?? []).length >= 2, 'the menu holds focusable links');
  assert.match(js, /menu\.hidden\s*=\s*!open/, 'site.js setMenu() opens the menu by clearing hidden');
});

test('precondition: on every page something focusable follows the menu (in <main> or the footer)', () => {
  const footer = layout.slice(layout.indexOf('<footer'));
  assert.ok((footer.match(FOCUSABLE) ?? []).length > 0, 'the footer has links');
  assert.ok((pageBody('index.html').match(FOCUSABLE) ?? []).length > 0, 'the home page has links in <main>');
  for (const p of PAGES) assert.ok((pageBody(p) + footer).match(FOCUSABLE), `${p} has nothing focusable after the menu`);
});

test('with the phone menu open, Tab past its last item does not move focus into the page hidden under it', () => {
  const menu = topRule('.menu');
  const covers = menu.position === 'fixed' && /^0(px)?$/.test(menu.inset ?? '');
  const keepsFocus = {
    'the page behind made inert': /\binert\b/.test(js),
    'Tab handled while the menu is open': /['"]Tab['"]/.test(js),
    'focus leaving the menu closes or returns it': /\bfocus(?:in|out)\b/.test(js),
    'a modal dialog': /\bshowModal\s*\(/.test(js) || /<dialog\b[^>]*\bid="menu"/.test(layout),
  };
  const guards = Object.entries(keepsFocus).filter(([, on]) => on).map(([k]) => k);
  assert.ok(!covers || guards.length > 0,
    `site.css .menu is { position: ${menu.position}; inset: ${menu.inset}; z-index: ${menu['z-index']}; background: ${menu.background} } ` +
    `(it covers the whole viewport), #menu comes right before <main>, and site.js does none of: ${Object.keys(keepsFocus).join('; ')}. ` +
    'So after the menu\'s last item, Tab focuses links and fields in the page under the open menu, where they cannot be seen');
});
