// Adversary round 49 on the site (2be81cb..6b107fa). Intended home: packages/site/test/proves-fits-at-200-zoom.test.mjs
// Run from the repo root: node --test packages/site/test/proves-fits-at-200-zoom.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// packages/site/README.md:102 to 103 says "Short screens (under about 860px tall) tighten the story and the proves section so
// they fit", and site.css:569 says "Short screens (iPad landscape, 768px laptops): the two lists must fit inside
// the pinned screen". README.md:109 lists 1440px among the widths checked, and earlier rounds hold the site to
// 200% browser zoom (menu-fits-at-200-zoom.test.mjs:6 to 10): a 1440x900 screen at 200% lays the page out at
// 720x450 CSS px, so the desktop layout (720px and wider) with its pinned scenes is what a low-vision user
// on that laptop gets (WCAG 2.2 SC 1.4.4 Resize Text, AA).
//
// With everything working (scene.js marks html.scene-live), the home page's "What this proves, and what it
// doesn't" section (index.html:244 to 257) is pinned:
//   - site.css:345 makes .scene-sticky `position: sticky; top: 0; height: 100svh; display: flex;
//     align-items: center; overflow: hidden`, and only :root:not(.scene-live) (site.css:349) or the phone
//     rule (max-width: 719px, site.css:455) undo it. Nothing undoes it for a short screen.
//   - site.css:346 pads its .wrap by the 68px nav bar, and the two lists sit side by side in a three-track
//     grid (site.css:552), each list about 223px wide at 720px, its text 193px after the icon column.
//   - The short-screen rules (site.css:570 to 578) shrink the type, but the six "What it doesn't show" claims
//     still need many lines in that width.
// The section's content is taller than the 450px box. align-items: center splits the overflow between both
// ends and overflow: hidden cuts both off; nothing scrolls the box (scroll moves the page past a pinned box,
// and an overflow above a flex container's start edge can't be scrolled to at all). So the heading, the lede
// and its "security page" link sit above the top of the box: unreadable, and a focused link that can't be
// shown (SC 2.4.11 Focus Not Obscured).
//
// Measured on the built page (adv-site-r49 worktree at 6b107fa, dist as built), headless Chromium 1243
// (playwright-core), 2026-11-05, every non-site request aborted except a stub 'three' module so scene.js marks
// scene-live (fallback fonts, DejaVu Sans), the page scrolled until the section is pinned (probe/pinscan.mjs
// beside this file):
//   720x450: H2 "What this proves, and what it doesn't" at -217 to -150 (box 0 to 450, nav bar to 68): wholly
//     cut off. The lede at -134 to -58 and its "security page" link at -80 to -61: cut off. Both list
//     headings "What a proof shows" / "What it doesn't show" at -21 to 29: cut off, under the nav bar.
//   768x432 (1536x864 at 200%): the same, H2 at -198 to -129. 1024x600: H2 at -11 to 71, cut and under the nav.
// The same probe finds the home page's other pinned sections cut the same way at 720x450 (outcomes: H2 "Three
// ways a call can end" at -141 to 27; explorer search: its Check button at 515 to 554, below the box) and the
// story's first step H2 at -24 to 98.
//
// The test does not need a browser. It evaluates site.css's cascade (the round 38 to 48 harness, with
// :first-child, :last-child and :nth-child(n) added) for the section as the page ships it at 720x450 with
// scene-live, and computes a floor for its content height that no font can get under: every heading and the
// lede take one line, and each claim takes at least as many lines as its characters need at 0.3em per
// character, which is narrower than any text face (Helvetica, Arial and Geist average about 0.5em on English
// text, and 0.3em is a condensed face's average). Line breaks at spaces only add lines. If that floor does not
// fit the pinned box and the box clips, content is cut off whatever font arrives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(src, 'static', 'assets', 'site.css'), 'utf8');
const layout = readFileSync(join(src, 'layout.html'), 'utf8');
const page = name => {
  const raw = readFileSync(join(src, 'pages', name), 'utf8');
  const meta = Object.fromEntries([...raw.matchAll(/^<!--\s*(\w+):\s*(.*?)\s*-->\s*$/gm)].map(m => [m[1], m[2]]));
  const body = raw.replace(/^<!--\s*\w+:.*?-->\s*\r?\n/gm, '')
    .replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, p) => readFileSync(join(src, 'partials', `${p}.html`), 'utf8'));
  return layout.replace('{{content}}', () => body).replace(/\{\{bodyClass\}\}/g, meta.body ?? '');
};

// ---- HTML: elements with parents and their own text, from a tag stack ----
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
function elements(html) {
  const out = [];
  const stack = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  let last = 0;
  for (const m of clean.matchAll(/<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g)) {
    const text = clean.slice(last, m.index);
    for (const e of stack) e.text += text;
    last = m.index + m[0].length;
    const [whole, tagRaw, attrText, selfClose] = m;
    const tag = tagRaw.toLowerCase();
    if (whole.startsWith('</')) {
      const i = stack.map(e => e.tag).lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    const attrs = {};
    for (const a of attrText.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    const el = { tag, attrs, classes: new Set((attrs.class ?? '').split(/\s+/).filter(Boolean)), parent: stack.at(-1) ?? null, children: [], text: '' };
    el.parent?.children.push(el);
    out.push(el);
    if (!VOID.has(tag) && !selfClose) stack.push(el);
  }
  return out;
}

// ---- CSS: rules with their media context ----
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
const words = v => splitTop(v.trim(), ' ').filter(Boolean);
// The size and line-height in a `font` shorthand: the token before an optional /line-height, ahead of the family.
const fontParts = font => {
  const m = splitTop(font, ',')[0].match(/(?:^|\s)((?:clamp|min|max|calc)\([^]*?\)|[\d.]+(?:px|rem|em|vw|%))(?:\/(\S+))?(?=\s)/);
  return m ? { size: m[1], lh: m[2] } : {};
};
// Box shorthands (padding: 1 to 4 values) into longhands.
const sides = v => { const p = words(v); return { top: p[0], right: p[1] ?? p[0], bottom: p[2] ?? p[0], left: p[3] ?? p[1] ?? p[0] }; };
const borderWidth = v => words(v).find(t => /^(0|[\d.]+px|thin|medium|thick)$/.test(t)) ?? 'medium';
function rules(text) {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let order = 0;
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
      else if (prelude.startsWith('@')) { /* @keyframes, @supports: not used for these props */ }
      else {
        const decls = {};
        const set = (prop, d, val) => { if (!(prop in decls)) decls[prop] = { ...d, val }; };
        for (const d of splitTop(inner, ';')) {
          const k = d.indexOf(':');
          if (k < 0) continue;
          const prop = d.slice(0, k).trim().toLowerCase();
          let val = d.slice(k + 1).trim();
          const important = /!important\s*$/.test(val);
          val = val.replace(/!important\s*$/, '').trim();
          decls[prop] = { val, important };
        }
        // Shorthands this test reads as longhands (a longhand in the same rule wins, as it comes later here).
        if (decls.font) { const f = fontParts(decls.font.val); if (f.size) set('font-size', decls.font, f.size); set('line-height', decls.font, f.lh ?? 'normal'); }
        if (decls.padding) { const p = sides(decls.padding.val); for (const k of ['top', 'right', 'bottom', 'left']) set(`padding-${k}`, decls.padding, p[k]); }
        if (decls['padding-block']) { const p = words(decls['padding-block'].val); set('padding-top', decls['padding-block'], p[0]); set('padding-bottom', decls['padding-block'], p[1] ?? p[0]); }
        if (decls.border) for (const k of ['top', 'bottom']) set(`border-${k}-width`, decls.border, borderWidth(decls.border.val));
        for (const k of ['top', 'bottom']) if (decls[`border-${k}`]) set(`border-${k}-width`, decls[`border-${k}`], borderWidth(decls[`border-${k}`].val));
        if (decls.overflow) { const o = words(decls.overflow.val); set('overflow-y', decls.overflow, o[1] ?? o[0]); }
        if (decls.gap) set('row-gap', decls.gap, words(decls.gap.val)[0]);
        if (decls['flex-flow']) set('flex-direction', decls['flex-flow'], words(decls['flex-flow'].val).find(t => /^(row|column)/.test(t)) ?? 'row');
        for (const sel of splitTop(prelude, ',')) out.push({ sel: sel.trim(), media, decls, order: order++ });
      }
      i = j;
    }
  };
  parse(s, []);
  return out;
}

function mediaMatches(list, env) {
  return list.every(q => q.split(/\s+and\s+/).every(f => {
    const m = f.trim().match(/^\(\s*([\w-]+)\s*:\s*([^)]+?)\s*\)$/);
    if (!m) throw new Error(`unsupported media query: ${q}`);
    const [, feat, v] = m;
    const px = parseFloat(v);
    switch (feat) {
      case 'max-width': return env.width <= px;
      case 'min-width': return env.width >= px;
      case 'max-height': return env.height <= px;
      case 'min-height': return env.height >= px;
      case 'max-aspect-ratio': case 'min-aspect-ratio': case 'orientation': throw new Error(`unsupported media feature: ${feat}`);
      case 'prefers-reduced-motion': return v === env.motion;
      case 'hover': return v === (env.touch ? 'none' : 'hover');
      case 'pointer': return v === (env.touch ? 'coarse' : 'fine');
      default: throw new Error(`unsupported media feature: ${feat}`);
    }
  }));
}

// ---- Selectors: compounds joined by descendant or child combinators ----
function parseSelector(sel) {
  const tokens = sel.replace(/\s*([>+~])\s*/g, ' $1 ').trim().split(/\s+/);
  const parts = [];
  let comb = ' ';
  for (const t of tokens) { if (/^[>+~]$/.test(t)) { comb = t; continue; } parts.push({ comb, compound: t }); comb = ' '; }
  return parts;
}
function matchCompound(c, el) {
  let spec = [0, 0, 0];
  let rest = c;
  if (/::/.test(rest)) return { ok: false, spec };
  if (/^[+~]$/.test(rest)) return { unsupported: true };
  const tagM = rest.match(/^([a-zA-Z][\w-]*|\*)/);
  if (tagM) {
    if (tagM[1] !== '*') { if (el.tag !== tagM[1].toLowerCase()) return { ok: false, spec }; spec[2]++; }
    rest = rest.slice(tagM[1].length);
  }
  let ok = true;
  while (rest.length) {
    let m;
    if ((m = rest.match(/^\.([\w-]+)/))) { spec[1]++; if (!el.classes.has(m[1])) ok = false; }
    else if ((m = rest.match(/^#([\w-]+)/))) { spec[0]++; if (el.attrs.id !== m[1]) ok = false; }
    else if ((m = rest.match(/^\[([\w-]+)(?:([~|^$*]?=)"?([^"\]]*)"?)?\]/))) {
      spec[1]++;
      const v = el.attrs[m[1]];
      if (v === undefined) ok = false;
      else if (m[2] === '=' && v !== m[3]) ok = false;
      else if (m[2] === '^=' && !v.startsWith(m[3])) ok = false;
      else if (m[2] && !['=', '^='].includes(m[2])) return { unsupported: true };
    }
    else if ((m = rest.match(/^:root/))) { spec[1]++; if (el.tag !== 'html') ok = false; }
    else if ((m = rest.match(/^:not\(([^()]*)\)/))) {
      const inner = matchCompound(m[1], el);
      if (inner.unsupported) return inner;
      spec = spec.map((n, i) => n + inner.spec[i]);
      if (inner.ok) ok = false;
    }
    else if ((m = rest.match(/^:(first-child|last-child|nth-child\([^)]*\)|hover|focus|focus-visible|focus-within|active|checked|disabled)/))) {
      spec[1]++;
      // Structural pseudo-classes from the element's place among its parent's element children.
      const sibs = el.parent?.children ?? [el];
      const pos = sibs.indexOf(el) + 1;
      if (m[1] === 'first-child') { if (pos !== 1) ok = false; }
      else if (m[1] === 'last-child') { if (pos !== sibs.length) ok = false; }
      else if (m[1].startsWith('nth-child')) {
        const n = m[1].match(/^nth-child\(\s*(\d+)\s*\)$/);
        if (!n) return { unsupported: true };
        if (pos !== Number(n[1])) ok = false;
      }
      else ok = false;
    }
    else return { unsupported: true };
    rest = rest.slice(m[0].length);
  }
  return { ok, spec };
}
function matchSelector(sel, el) {
  const parts = parseSelector(sel);
  let spec = [0, 0, 0];
  const r = matchCompound(parts.at(-1).compound, el);
  if (r.unsupported) return { unsupported: true };
  if (!r.ok) return { ok: false };
  spec = spec.map((n, i) => n + r.spec[i]);
  let cur = el;
  for (let k = parts.length - 2; k >= 0; k--) {
    const comb = parts[k + 1].comb;
    let found = null;
    // Candidates: ancestors for ' ', the parent for '>', the previous sibling for '+', earlier siblings for '~'.
    const sibs = cur.parent?.children ?? [];
    const before = sibs.slice(0, sibs.indexOf(cur)).reverse();
    const cands = comb === '+' ? before.slice(0, 1) : comb === '~' ? before : comb === '>' ? [cur.parent].filter(Boolean) : (() => { const a = []; for (let p = cur.parent; p; p = p.parent) a.push(p); return a; })();
    for (const a of cands) {
      const rr = matchCompound(parts[k].compound, a);
      if (rr.unsupported) return { unsupported: true };
      if (rr.ok) { found = a; spec = spec.map((n, i) => n + rr.spec[i]); break; }
    }
    if (!found) return { ok: false };
    cur = found;
  }
  return { ok: true, spec };
}

const RULES = rules(css);
const lexGreaterOrEqual = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };
// A selector this harness can't read is fatal only if its subject could be one of the elements measured here:
// the root, the section's pinned box and wrap, its heading and lede, the two lists, their headings and claims.
const RELEVANT = /:root|\b(html|section|div|h2|h3|p|ul|li)\b|\.(scene-sec|proves-sec|scene-sticky|wrap|sec-head|sec-lede|split|proves|claims)\b|\[data-side|\[data-at|^\*|\s\*/;
const relevantSubject = sel => { const subj = parseSelector(sel).at(-1).compound; return !/::/.test(subj) && !/^(a|span|strong|i|b|svg|code|button|input|img|pre|table|tr|td|th|dt|dd|dl|ol|nav|header|footer|canvas)\b/.test(subj); };
function computed(el, prop, env) {
  let best = null;
  for (const r of RULES) {
    if (!(prop in r.decls) || !mediaMatches(r.media, env)) continue;
    const m = matchSelector(r.sel, el);
    if (m.unsupported) {
      if (relevantSubject(r.sel) && RELEVANT.test(r.sel)) throw new Error(`selector not supported by this test: ${r.sel} (${prop})`);
      continue;
    }
    if (!m.ok) continue;
    const key = [r.decls[prop].important ? 1 : 0, ...m.spec, r.order];
    if (!best || lexGreaterOrEqual(key, best.key)) best = { key, val: r.decls[prop].val };
  }
  return best?.val;
}
const INHERITED = new Set(['font-size', 'line-height']);
function get(el, prop, env) {
  if (!INHERITED.has(prop)) return computed(el, prop, env);
  for (let a = el; a; a = a.parent) { const v = computed(a, prop, env); if (v !== undefined && v !== 'inherit') return v; }
  return undefined;
}

// ---- Lengths ----
const ROOT_FS = 16;
function px(v, { em, env, vars = {} }) {
  v = String(v).trim().replace(/var\((--[\w-]+)\)/g, (_, n) => { if (!(n in vars)) throw new Error(`unknown ${n}`); return vars[n]; });
  let m;
  if ((m = v.match(/^max\((.*)\)$/))) return Math.max(...splitTop(m[1], ',').filter(p => !/env\(/.test(p)).map(p => px(p, { em, env, vars })));
  if ((m = v.match(/^min\((.*)\)$/))) return Math.min(...splitTop(m[1], ',').map(p => px(p, { em, env, vars })));
  if ((m = v.match(/^clamp\((.*)\)$/))) { const [lo, mid, hi] = splitTop(m[1], ',').map(p => px(p, { em, env, vars })); return Math.min(hi, Math.max(lo, mid)); }
  if ((m = v.match(/^calc\((.*)\)$/))) return px(m[1], { em, env, vars });
  const terms = words(v);
  if (terms.length > 1) {
    let sum = px(terms[0], { em, env, vars });
    for (let i = 1; i < terms.length; i += 2) {
      if (!['+', '-'].includes(terms[i])) throw new Error(`length not supported by this test: ${v}`);
      sum += (terms[i] === '+' ? 1 : -1) * px(terms[i + 1], { em, env, vars });
    }
    return sum;
  }
  if (v === '0') return 0;
  if (v === 'thin') return 1;
  if (v === 'medium') return 3;
  if (v === 'thick') return 5;
  if ((m = v.match(/^(-?[\d.]+)(px|rem|em|vw|vh|svh|dvh|lvh)$/))) {
    const n = parseFloat(m[1]);
    return { px: n, rem: n * ROOT_FS, em: n * em, vw: n * env.width / 100 }[m[2]] ?? n * env.height / 100;
  }
  throw new Error(`length not supported by this test: ${v}`);
}


// ---- The proves section, pinned at 200% zoom on a 1440x900 screen ----
const ENV = { name: '1440x900 screen at 200% zoom', width: 720, height: 450, touch: false, motion: 'no-preference' };
// The narrowest average advance any text face gets to (see the header).
const MIN_ADVANCE_EM = 0.3;

test(`home page "What this proves, and what it doesn't", ${ENV.name} (${ENV.width}x${ENV.height} CSS px), with everything working: the pinned section's content fits its box, or the box lets it be reached`, () => {
  const els = elements(page('index.html'));
  const html = els[0];
  assert.ok(html.tag === 'html' && html.classes.has('no-js'), 'layout ships <html class="no-js">');
  html.classes.delete('no-js');
  html.classes.add('scene-live'); // scene.js, once three.js has loaded

  const kid = (el, pred, what) => { const k = el.children.find(pred); assert.ok(k, `control: ${what}`); return k; };
  const sec = els.find(e => e.tag === 'section' && e.classes.has('proves-sec'));
  assert.ok(sec, 'control: index.html has section.proves-sec');
  const sticky = kid(sec, c => c.classes.has('scene-sticky'), 'the section holds a .scene-sticky');
  const wrap = kid(sticky, c => c.classes.has('wrap'), '.scene-sticky holds a .wrap');
  const head = kid(wrap, c => c.classes.has('sec-head'), '.wrap holds the .sec-head');
  const h2 = kid(head, c => c.tag === 'h2', '.sec-head has the h2');
  const lede = kid(head, c => c.classes.has('sec-lede'), '.sec-head has the lede');
  const split = kid(wrap, c => c.classes.has('split'), '.wrap holds the .split');
  const proves = kid(split, c => c.classes.has('proves'), '.split holds .proves');
  const sides = proves.children.filter(c => c.attrs['data-side']);
  assert.equal(sides.length, 2, 'control: two lists, left and right');

  const vars = { '--nav-h': computed(html, '--nav-h', ENV), '--gutter': computed(html, '--gutter', ENV) };
  const fsOf = el => px(get(el, 'font-size', ENV) ?? `${ROOT_FS}px`, { em: ROOT_FS, env: ENV, vars });
  const L = (el, prop, fallback = '0') => px(computed(el, prop, ENV) ?? fallback, { em: fsOf(el), env: ENV, vars });
  const lineH = el => {
    const raw = get(el, 'line-height', ENV);
    const fs = fsOf(el);
    if (!raw || raw === 'normal') return fs; // a floor: no face's normal line height is under 1
    return /^[\d.]+$/.test(raw) ? Number(raw) * fs : px(raw, { em: fs, env: ENV, vars });
  };
  const gapOf = (el, axis) => { const g = words(computed(el, 'gap', ENV) ?? '0'); return px(axis === 'row' ? g[0] : (g[1] ?? g[0]), { em: fsOf(el), env: ENV, vars }); };
  const clean = t => t.replace(/\{\{[^}]*\}\}/g, '').replace(/&[#\w]+;/g, 'x').replace(/\s+/g, ' ').trim();

  // Controls: at this width and state the box is pinned, one screen tall, and a centring flex box.
  const position = computed(sticky, 'position', ENV);
  const heightRaw = computed(sticky, 'height', ENV);
  const overflowY = computed(sticky, 'overflow-y', ENV) ?? words(computed(sticky, 'overflow', ENV) ?? 'visible').at(-1);
  const align = (computed(sticky, 'align-items', ENV) ?? 'normal').trim();
  const pinned = /^(sticky|fixed)$/.test(position ?? 'static') && heightRaw && heightRaw !== 'auto';
  const boxH = pinned ? px(heightRaw, { em: ROOT_FS, env: ENV, vars }) : Infinity;

  // Widths: the .wrap's content box, then the widest track of the three-track grid (a wider column only
  // means fewer lines, so this stays a floor), then the claim text beside its icon column.
  const wrapW = Math.min(ENV.width, L(wrap, 'max-width', `${ENV.width}px`)) - L(wrap, 'padding-left') - L(wrap, 'padding-right');
  const tracks = splitTop(computed(proves, 'grid-template-columns', ENV), ' ').filter(Boolean);
  const frs = tracks.map(t => { const m = t.match(/([\d.]+)fr/); assert.ok(m && /^minmax\(0,/.test(t.replace(/\s/g, '')), `control: track ${t} is minmax(0, Nfr)`); return Number(m[1]); });
  const colW = (wrapW - gapOf(proves, 'col') * (tracks.length - 1)) * Math.max(...frs) / frs.reduce((a, b) => a + b, 0);

  const sideH = side => {
    const h3 = kid(side, c => c.tag === 'h3', 'the list has its h3');
    const list = kid(side, c => c.classes.has('claims'), 'the list has its .claims');
    const lis = list.children.filter(c => c.tag === 'li');
    let h = L(side, 'padding-top') + lineH(h3) + L(h3, 'margin-bottom');
    const out = [];
    for (const li of lis) {
      const icon = px(words(computed(li, 'grid-template-columns', ENV) ?? '0')[0], { em: fsOf(li), env: ENV, vars });
      const textW = colW - icon - gapOf(li, 'col');
      const text = clean(li.text);
      const lines = Math.max(1, Math.ceil(text.length * MIN_ADVANCE_EM * fsOf(li) / textW));
      out.push(lines);
      h += lines * lineH(li);
    }
    h += gapOf(list, 'row') * Math.max(0, lis.length - 1);
    return { h, lines: out, h3: clean(h3.text) };
  };
  const [left, right] = sides.map(sideH);
  const tallest = left.h >= right.h ? left : right;

  const content = L(sticky, 'padding-top') + L(wrap, 'padding-top') + lineH(h2) + L(lede, 'margin-top') + lineH(lede) + L(split, 'margin-top') + tallest.h + L(wrap, 'padding-bottom') + L(sticky, 'padding-bottom');
  const free = boxH - content;
  const clips = /^(hidden|clip)$/.test(overflowY);
  const scrollsWholly = /^(auto|scroll)$/.test(overflowY) && /^(normal|stretch|flex-start|start|safe .+)$/.test(align);
  const h2Top = (/^(center|unsafe center)$/.test(align) ? free / 2 : 0) + L(wrap, 'padding-top');

  const ok = !pinned || free >= -0.5 || scrollsWholly;
  assert.ok(ok,
    `the pinned box is ${boxH}px tall (position: ${position}, height: ${heightRaw}, overflow-y: ${overflowY}, align-items: ${align}), ` +
    `but its content needs at least ${content.toFixed(1)}px even with every heading on one line and text at ${MIN_ADVANCE_EM}em a character ` +
    `(columns ${colW.toFixed(1)}px; "${tallest.h3}" claims at least ${tallest.lines.join(', ')} lines). ` +
    `${clips ? 'overflow cuts off' : 'nothing scrolls to'} ${(-free).toFixed(1)}px` +
    `${/center/.test(align) ? `, half of it above the box, where nothing can scroll to it: the h2 "${clean(h2.text)}" starts at ` +
      `${h2Top.toFixed(1)}px${h2Top < 0 ? ', above the top of the screen' : ''}` +
      `${h2Top < L(wrap, 'padding-top') ? `, under the ${L(wrap, 'padding-top')}px nav bar` : ''}` : ''}`);
});
