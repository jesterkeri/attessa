// Adversary round 46 on the site (2be81cb1..d8003ec). Intended home: site/test/menu-breakpoint-no-gap.test.mjs
// Run from the repo root: node --test site/test/menu-breakpoint-no-gap.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The menu button shows only inside `@media (max-width: 1020px)` (site.css:166 to 169; `.icon-btn` is
// display: none otherwise, site.css:147). site.js closes the open menu when `matchMedia('(min-width:
// 1021px)')` starts to match (site.js:53 to 54, "Same breakpoint as site.css"). Those two queries are not
// complements: a viewport wider than 1020px and narrower than 1021px matches neither. CSS widths are not
// whole numbers whenever the scale is not 100%: a 1276-device-pixel window on a Windows desktop at 125% is
// 1276 / 1.25 = 1020.8px, 1531 at 150% is 1020.67px, a 1123px window at browser zoom 110% is 1020.91px.
// Open the menu below 1020px and grow the window to such a width: the button goes (display: none), the
// desktop links come back over the top, the 1021px query never fires, and the full-screen menu stays open
// with nothing on screen to close it (site.js:33 "the same button closes it"), main and footer still inert.
// Measured on the built pages (site/dist at d8003ec), headless Chromium 1243 shell (playwright-core),
// 2026-11-05, index.html, JavaScript on with every third-party host failing DNS, --force-device-scale-factor
// =1.17, menu opened with the keyboard at 1016px, then the window widened one DIP at a time through CDP
// (probe/fracscan.mjs in this round's scratch folder):
//   window 1019: vv=1019.658 max1020=true  min1021=false menuOpen=true btnDisplay=grid navLinks=none mainInert=true
//   window 1020: vv=1020.513 max1020=false min1021=false menuOpen=true btnDisplay=none navLinks=flex mainInert=true
// The screenshot at 1020.513px shows the full-screen menu under the desktop nav bar, no close button.
// (Back-forward cache, round 45's lead: dropped. Full Chromium restores the page with pageshow persisted=true
// and the change event fires, mq:true, so the menu closes; probe/bfreal.mjs.)
//
// The test needs no browser. It reads the media queries that show the menu button in site.css and the
// matchMedia query that closes the menu in site.js, and checks every CSS width a screen can produce near the
// breakpoint (whole device pixels divided by a common scale: Windows 100 to 300%, browser zoom 67 to 200%)
// for one where the open menu has neither its button nor a close. Any fix that leaves no such width passes:
// the same query both ways (`(max-width: 1020px)` with `!e.matches`, or `not all and (max-width: 1020px)`,
// or `(width > 1020px)`), or a fractional breakpoint like Bootstrap's 1020.98px / 1021px pair that no
// listed scale can land between.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(join(src, 'static', 'assets', 'site.css'), 'utf8'));
const js = strip(readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8')).replace(/^\s*\/\/.*$/gm, '');

// The balanced {...} or (...) group that opens at or after `from`.
function group(text, from, open = '{') {
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

// A media query on width only, evaluated at a CSS width w. Supports what site.css and site.js could
// reasonably use: (min-width|max-width: Npx), range syntax (width > N px) etc., `not all and`, `screen and`,
// and comma lists. Anything else returns undefined so the test says so instead of guessing.
function mq(query, w) {
  const parts = query.split(',').map(s => s.trim());
  if (parts.length > 1) { const r = parts.map(p => mq(p, w)); return r.includes(undefined) ? undefined : r.some(Boolean); }
  let q = query.trim();
  let negate = false;
  const not = q.match(/^not\s+(?:all|screen)\s+and\s+/i);
  if (not) { negate = true; q = q.slice(not[0].length); }
  q = q.replace(/^(?:only\s+)?(?:all|screen)\s+and\s+/i, '');
  const conds = q.split(/\s+and\s+/i);
  let ok = true;
  for (const c of conds) {
    let m;
    if ((m = c.match(/^\(\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)$/i))) {
      const n = Number(m[2]); ok &&= m[1].toLowerCase() === 'min' ? w >= n : w <= n;
    } else if ((m = c.match(/^\(\s*width\s*(>=|<=|>|<)\s*([\d.]+)px\s*\)$/i))) {
      const n = Number(m[2]); ok &&= { '>=': w >= n, '<=': w <= n, '>': w > n, '<': w < n }[m[1]];
    } else if ((m = c.match(/^\(\s*([\d.]+)px\s*(<=|<)\s*width\s*\)$/i))) {
      const n = Number(m[1]); ok &&= m[2] === '<' ? w > n : w >= n;
    } else return undefined;
  }
  return negate ? !ok : ok;
}

// Every @media block whose rules show the menu button (.icon-btn or .menu-btn with a display other than none).
const shows = [];
for (const m of css.matchAll(/@media([^{]+)\{/g)) {
  const body = group(css, m.index + m[0].length - 1);
  for (const r of body.slice(1, -1).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/\.(?:icon-btn|menu-btn)\b/.test(r[1]) && !/\.no-js/.test(r[1])) {
      const d = r[2].match(/display\s*:\s*([^;]+)/);
      if (d && d[1].trim() !== 'none') shows.push(m[1].trim());
    }
  }
}
const buttonShown = w => shows.some(q => mq(q, w));

// The matchMedia listener that closes the menu: its query and whether it closes on matches or on !matches.
const closer = (() => {
  for (const m of js.matchAll(/matchMedia\(\s*(['"`])(.+?)\1\s*\)/g)) {
    const tail = js.slice(m.index, m.index + 400);
    const at = tail.search(/addEventListener\(\s*['"]change['"]/);
    if (at < 0) continue;
    const handler = group(tail, at, '(');
    if (!/setMenu\(\s*false\s*\)/.test(handler)) continue;
    return { query: m[2], onMatch: !/!\s*\w+\.matches/.test(handler) };
  }
  return null;
})();
const jsCloses = w => { const v = mq(closer.query, w); return v === undefined ? undefined : v === closer.onMatch; };

// CSS widths a screen produces near the breakpoint: whole device pixels over a common scale. Windows display
// scaling 100 to 300%, macOS/Linux 1x to 3x, and browser zoom 67 to 200% (alone and on a 125% or 150% display).
const scales = [...new Set([1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 0.67, 0.75, 0.8, 0.9,
  1.25 * 1.1, 1.25 * 1.25, 1.5 * 1.1, 1.5 * 1.25, 1.25 * 0.9, 1.5 * 0.9].map(s => Math.round(s * 10000) / 10000))];
const widths = [];
for (const s of scales) for (let k = Math.floor(1000 * s); k <= Math.ceil(1040 * s); k++) widths.push({ w: k / s, k, s });

test('precondition: site.css shows the menu button in a media query and site.js closes the menu from one', () => {
  assert.ok(shows.length > 0, 'site.css shows .icon-btn / .menu-btn inside an @media block');
  assert.ok(closer, 'site.js closes the menu (setMenu(false)) from a matchMedia change listener');
  for (const q of [...shows, closer.query]) assert.notEqual(mq(q, 1000), undefined, `this test can read the media query "${q}"`);
  assert.equal(buttonShown(390), true, 'the button shows on a phone');
  assert.equal(buttonShown(1440), false, 'the button is hidden on a desktop');
  assert.equal(jsCloses(1440), true, 'a desktop width closes the menu');
});

test('no reachable CSS width leaves the open menu with neither its button nor a close (no gap between the breakpoints)', () => {
  const stuck = widths.filter(({ w }) => !buttonShown(w) && !jsCloses(w));
  assert.deepEqual(stuck.map(({ w, k, s }) => `${w.toFixed(3)}px (${k} device px at ${Math.round(s * 100)}%)`), [],
    `the menu button shows at ${shows.join(' / ')} (site.css) but site.js closes the menu only when ` +
    `matchMedia('${closer.query}') ${closer.onMatch ? 'starts to match' : 'stops matching'}. At these widths ` +
    'neither holds, so a menu opened on a narrower window and then widened to one of them stays full-screen, ' +
    'with main and footer inert and no button on screen to close it');
});
