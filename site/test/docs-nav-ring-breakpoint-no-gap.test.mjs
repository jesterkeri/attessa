// Adversary round 54 on the site (2be81cb..a77fd08). Intended home: site/test/docs-nav-ring-breakpoint-no-gap.test.mjs
// Run from the repo root: node --test site/test/docs-nav-ring-breakpoint-no-gap.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// Round 53 found that the desktop docs menu clips its links' focus rings, and the fix (c5811fa) gave the menu
// 6px of room: site.css:899 `@media (min-width: 861px) { .docs-nav { padding: 0 6px 6px; margin-left: -6px; } }`.
// But the menu stops being the desktop column only at site.css:969 `@media (max-width: 860px)` (where
// `.docs-nav { position: static; max-height: none; overflow: visible; }`). Those two queries are not
// complements: a viewport wider than 860px and narrower than 861px matches neither, so the menu is the sticky
// column that clips (site.css:897 `overflow-y: auto`, which makes overflow-x auto too) with no padding, and
// round 53's cut is back: the focused link's ring loses its left and right sides. Round 46 found the same gap
// at the 1020 / 1021px menu breakpoint (menu-breakpoint-no-gap.test.mjs); CSS widths are not whole numbers
// whenever the scale is not 100%: a 1076-device-pixel window on a 125% Windows display is 860.8px, 947px at
// browser zoom 110% is 860.91px, 1291 at 150% is 860.67px.
//
// Measured on the built pages (adv-site-r54 worktree at a77fd08, dist as built), headless Chromium
// (playwright-core, chrome-headless-shell 1243), 2026-11-05, --force-device-scale-factor=1.17, JS on with
// every third-party host failing DNS, docs/reference.html, Tab to the first docs-menu link ("Overview"),
// screenshot of the link plus 8px with the ring and with outline-style none, changed pixels per side
// (probe/fracnav.mjs beside this file):
//   window 860: vv=860.684 max860=false min861=false nav ov=auto/auto pos=sticky pad="0px" ml=0px
//     ring px {"top":210,"right":0,"bottom":420,"left":0}
//   window 861: vv=861.539 max860=false min861=true  nav ov=auto/auto pos=sticky pad="0px 6px 6px" ml=-6px
//     ring px {"top":204,"right":81,"bottom":408,"left":84}
// At 860.684px the ring is two horizontal lines (screenshot probe/ring-860.png), at 861.539px a whole box
// (probe/ring-861.png).
//
// The test needs no browser. It evaluates the cascade of the rules that style `.docs-nav` itself (overflow,
// padding) and the focus ring a docs-menu link takes (outline-width + outline-offset), at every CSS width a
// screen can produce near the breakpoint (whole device pixels over a common scale, round 46's list), and
// asks: wherever the menu clips, is there room on its left and right for the ring? Any fix passes: one query
// both ways (`(width > 860px)`, `not all and (max-width: 860px)`), a fractional pair like 860.98 / 861px,
// padding that doesn't depend on a media query, or an inset ring for these links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(src, 'static', 'assets', 'site.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

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

// A media query at CSS width w (pointer and hover as a desktop with a mouse; height large). Width features in
// both syntaxes, `not all and`, `screen and`, comma lists. Anything else is undefined, so the test says so.
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

const all = rules(css);
// Rules that style the menu box itself, and rules that could set a docs-menu link's focus ring.
const navRules = all.filter(r => r.sels.includes('.docs-nav'));
const ringSel = /^(?:\*|a)?:focus-visible$|^\.docs-nav (?:[\w.-]+ )*a(?::focus-visible|:focus)?$|^a$/;
const ringRules = all.filter(r => r.sels.some(s => ringSel.test(s)));

const px = v => { const m = String(v).trim().match(/^(-?[\d.]+)(px)?$/); return m ? Number(m[1]) : NaN; };
const box = v => { const p = splitTop(v.trim(), ' ').filter(Boolean); return [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]]; };

function navStyle(w) {
  const s = { 'overflow-x': 'visible', 'overflow-y': 'visible', 'padding-left': '0', 'padding-right': '0' };
  for (const r of navRules) {
    const on = r.media.map(q => mq(q, w));
    if (on.includes(undefined)) throw new Error(`unsupported media query: ${r.media.join(' and ')}`);
    if (!on.every(Boolean)) continue;
    for (const [p, v] of r.decls) {
      if (p === 'overflow') { const o = splitTop(v, ' ').filter(Boolean); s['overflow-x'] = o[0]; s['overflow-y'] = o[1] ?? o[0]; }
      else if (p === 'overflow-x' || p === 'overflow-y') s[p] = v;
      else if (p === 'padding') { const [, rt, , lt] = box(v); s['padding-right'] = rt; s['padding-left'] = lt; }
      else if (p === 'padding-inline' || p === 'padding-inline-start' || p === 'padding-inline-end') {
        const [a, b] = splitTop(v, ' ').filter(Boolean);
        if (p !== 'padding-inline-end') s['padding-left'] = a;
        if (p !== 'padding-inline-start') s['padding-right'] = p === 'padding-inline' ? (b ?? a) : a;
      }
      else if (p in s) s[p] = v;
    }
  }
  // As computed: visible on one axis becomes auto when the other axis is not visible.
  if (s['overflow-x'] === 'visible' && s['overflow-y'] !== 'visible') s['overflow-x'] = 'auto';
  if (s['overflow-y'] === 'visible' && s['overflow-x'] !== 'visible') s['overflow-y'] = 'auto';
  return s;
}
// The ring's reach outside a focused docs-menu link: outline-offset + outline-width, from the rules that apply
// (later and more specific win; .docs-nav a:focus-visible overrides :focus-visible).
function ringReach(w) {
  let width = 0, offset = 0, wSpec = -1, oSpec = -1;
  const spec = s => (s.match(/[.:[]/g) ?? []).length * 10 + (/(^| )a(:|$)/.test(s) ? 1 : 0);
  for (const r of ringRules) {
    const on = r.media.map(q => mq(q, w));
    if (on.includes(undefined) || !on.every(Boolean)) continue;
    const sp = Math.max(...r.sels.filter(s => ringSel.test(s)).map(spec));
    for (const [p, v] of r.decls) {
      if (p === 'outline') {
        if (/\bnone\b/.test(v) && sp >= wSpec) { width = 0; wSpec = sp; continue; }
        const n = splitTop(v, ' ').map(px).find(x => !Number.isNaN(x));
        if (n !== undefined && sp >= wSpec) { width = n; wSpec = sp; }
      } else if (p === 'outline-width' && sp >= wSpec) { width = px(v); wSpec = sp; }
      else if (p === 'outline-style' && /none/.test(v) && sp >= wSpec) { width = 0; wSpec = sp; }
      else if (p === 'outline-offset' && sp >= oSpec) { offset = px(v); oSpec = sp; }
    }
  }
  return width > 0 ? Math.max(0, offset + width) : 0;
}
const clips = s => s['overflow-x'] !== 'visible' || s['overflow-y'] !== 'visible';

// CSS widths a screen produces near the breakpoint: whole device pixels over a common scale (round 46's list:
// Windows display scaling 100 to 300%, macOS/Linux 1x to 3x, browser zoom 67 to 200%, and zoom on 125 / 150%).
const scales = [...new Set([1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 0.67, 0.75, 0.8, 0.9,
  1.25 * 1.1, 1.25 * 1.25, 1.5 * 1.1, 1.5 * 1.25, 1.25 * 0.9, 1.5 * 0.9, 1.17].map(s => Math.round(s * 10000) / 10000))];
const widths = [];
for (const s of scales) for (let k = Math.floor(850 * s); k <= Math.ceil(872 * s); k++) widths.push({ w: k / s, k, s });

test('precondition: this test reads the docs menu the way the browser does at whole widths', () => {
  assert.ok(navRules.length >= 2, 'site.css has rules for .docs-nav');
  assert.ok(ringRules.some(r => r.sels.includes(':focus-visible') && r.decls.some(([p]) => p === 'outline' || p === 'outline-width')),
    'site.css draws a site-wide :focus-visible outline, which this test reads');  const desk = navStyle(1440), phone = navStyle(390);
  assert.ok(clips(desk), `the desktop docs menu clips (overflow ${desk['overflow-x']}/${desk['overflow-y']}), as in the browser`);
  assert.ok(!clips(phone), 'the phone docs menu does not clip');
  // Round 53's fix holds at the README's whole widths.
  for (const w of [1024, 1280, 1366, 1440]) {
    const s = navStyle(w);
    assert.ok(px(s['padding-left']) >= ringReach(w) && px(s['padding-right']) >= ringReach(w), `room for the ring at ${w}px`);
  }
});

test('at no reachable CSS width does the clipping docs menu cut a focused link\'s ring left and right', () => {
  const cut = widths.filter(({ w }) => {
    const s = navStyle(w);
    if (!clips(s)) return false;
    const reach = ringReach(w);
    return px(s['padding-left']) < reach || px(s['padding-right']) < reach;
  }).map(({ w, k, s }) => {
    const st = navStyle(w);
    return `${w.toFixed(3)}px (${k} device px at ${Math.round(s * 100)}%): overflow ${st['overflow-x']}/${st['overflow-y']}, padding left ${st['padding-left']} right ${st['padding-right']}, ring reaches ${ringReach(w)}px`;
  });
  assert.deepEqual(cut, [],
    'the docs menu clips (site.css:897 overflow-y: auto) unless (max-width: 860px) matches, but its 6px of room ' +
    'for a focused link\'s ring applies only from (min-width: 861px) (site.css:899). At these widths neither ' +
    'query matches, so round 53\'s cut is back: the ring loses its left and right sides');
});
