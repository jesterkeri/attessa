// Adversary round 50 on the site (2be81cb..07e58ba). Intended home: site/test/pinned-box-keyboard-scrolls.test.mjs
// Run from the repo root: node --test site/test/pinned-box-keyboard-scrolls.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// site/README.md:94 to 96 says "Short screens tighten the story (under about 820px tall) and the proves section
// (under about 960px) so they fit, and a pinned box that still overflows (200% zoom on a laptop) scrolls from its
// top", and site.css:350 to 352 does it with `.story-sticky, .scene-sticky { overflow-y: auto; ... }`. Earlier
// rounds hold the site to 200% zoom on a laptop (menu-fits-at-200-zoom.test.mjs, proves-fits-at-200-zoom.test.mjs):
// a 1440x900 screen at 200% lays the page out at 720x450 CSS px, the desktop layout with its pinned scenes.
//
// A box that scrolls only works for a keyboard user if the keyboard can reach it: the box is focusable or holds
// something focusable, so focus can sit in it and the arrow keys, Page Down and Space scroll it (WCAG 2.2 SC 2.1.1
// Keyboard, A; axe rule scrollable-region-focusable). Three of the boxes that overflow at 720x450 hold no link,
// button or field and have no tabindex: the story (index.html:43), "Three ways a call can end" (index.html:145)
// and the four uses (use-cases.html:27). With focus on the page, the keys scroll the page and never the box, so
// whatever the box holds below the screen stays there for the whole pinned run. Safari never makes a scroller
// focusable on its own; Chromium since version 130 adds an unnamed tab stop for such a box, the only way in.
//
// Measured on the built page (adv-site-r50 worktree at 07e58ba, dist as built), headless Chromium 153.0.8010.12
// (playwright-core), 2026-11-05, every non-site request aborted except a stub 'three' module so scene.js marks
// scene-live (fallback fonts), each section scrolled until its box is stuck, focus on <body> (probe/kbdbox.mjs
// beside this file):
//   720x450, index.html: the story box has 194px to scroll, the outcomes box 418px. ArrowDown, Page Down and
//     Space each leave the box at scrollTop 0 and move the page (40, 334 and 334px). The outcomes box's three
//     beats, the section's point, sit in those 418px below the screen. Tabbing, Chromium stops on the bare
//     DIV.story-sticky and DIV.scene-sticky themselves (its implicit scroller focus): nothing else in them can.
//   720x450, use-cases.html: the uses box has 99px to scroll; the same keys, the same result, the same bare stop.
//   (Explore, limits and proves overflow too, by 229, 286 and 569px, but each holds a field, button or link.)
// probe/wheelenter.mjs shows the pointer side of the same change: wheeling down while the outcomes box is still
// entering (its top at mid-screen) scrolls the box 418px before the page moves at all, so the box pins already
// scrolled to its end, its heading at -350 to -182.
//
// The test does not need a browser. It evaluates site.css's cascade (the round 38 to 49 harness) for each of
// those boxes as the page ships it at 720x450 with scene-live, checks the box is a pinned scroll container, and
// then asks whether the keyboard can get into it.
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
        // The overflow shorthand as its block-axis longhand (a longhand in the same rule wins).
        if (decls.overflow) { const o = words(decls.overflow.val); set('overflow-y', decls.overflow, o[1] ?? o[0]); }
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
// A selector this harness can't read is fatal only if its subject could be one of the boxes measured here (a div).
const relevantSubject = sel => {
  const subj = parseSelector(sel).at(-1).compound;
  if (/::/.test(subj)) return false;
  const tag = subj.match(/^([a-zA-Z][\w-]*)/)?.[1];
  if (tag && tag !== 'div') return false;
  const cls = [...subj.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
  return !cls.length || cls.every(k => ['story-sticky', 'scene-sticky'].includes(k));
};
function computed(el, prop, env) {
  let best = null;
  for (const r of RULES) {
    if (!(prop in r.decls) || !mediaMatches(r.media, env)) continue;
    const m = matchSelector(r.sel, el);
    if (m.unsupported) {
      if (relevantSubject(r.sel)) throw new Error(`selector not supported by this test: ${r.sel} (${prop})`);
      continue;
    }
    if (!m.ok) continue;
    const key = [r.decls[prop].important ? 1 : 0, ...m.spec, r.order];
    if (!best || lexGreaterOrEqual(key, best.key)) best = { key, val: r.decls[prop].val };
  }
  return best?.val;
}

// ---- The boxes, at 200% zoom on a 1440x900 screen ----
const ENV = { name: '1440x900 screen at 200% zoom', width: 720, height: 450, touch: false, motion: 'no-preference' };
// What the keyboard can focus: a tabindex of 0 or more, or a natively focusable element without a negative one.
const focusable = el => {
  const ti = el.attrs.tabindex;
  if (ti !== undefined && ti.trim() !== '') return Number(ti) >= 0;
  if ('disabled' in el.attrs && /^(button|input|select|textarea)$/.test(el.tag)) return false;
  if (el.tag === 'a' || el.tag === 'area') return 'href' in el.attrs;
  if (el.tag === 'input') return el.attrs.type !== 'hidden';
  return /^(button|select|textarea|summary|iframe)$/.test(el.tag) || ('contenteditable' in el.attrs && el.attrs.contenteditable !== 'false');
};
const descendants = el => el.children.flatMap(c => [c, ...descendants(c)]);
const label = el => el.text.replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

const CASES = [
  { file: 'index.html', what: 'the story (five steps)', find: els => els.find(e => e.classes.has('story-sticky') && e.parent && 'data-story' in e.parent.attrs) },
  { file: 'index.html', what: '"Three ways a call can end"', find: els => els.find(e => e.classes.has('scene-sticky') && e.parent?.classes.has('outcomes-sec')) },
  { file: 'use-cases.html', what: 'the four uses', find: els => els.find(e => e.classes.has('scene-sticky') && e.parent?.classes.has('uses-sec')) },
];

for (const c of CASES) {
  test(`${c.file}, ${c.what}, ${ENV.name} (${ENV.width}x${ENV.height} CSS px), with everything working: the pinned box scrolls, so the keyboard can reach it`, () => {
    const els = elements(page(c.file));
    const html = els[0];
    assert.ok(html.tag === 'html' && html.classes.has('no-js'), 'layout ships <html class="no-js">');
    html.classes.delete('no-js');
    html.classes.add('scene-live'); // scene.js, once three.js has loaded
    els.filter(e => 'data-story' in e.attrs).forEach(e => e.classes.add('is-live')); // scene.js:46

    const box = c.find(els);
    assert.ok(box, `control: ${c.file} has the box for ${c.what}`);
    const position = computed(box, 'position', ENV);
    const height = computed(box, 'height', ENV);
    const overflowY = computed(box, 'overflow-y', ENV);
    // Controls: in this state the box is pinned, one screen tall, and a scroll container that shows its overflow
    // by scrolling (site.css:352). If it stops being one, this test no longer applies and says so.
    assert.ok(/^(sticky|fixed)$/.test(position ?? '') && height && height !== 'auto',
      `control: the box is pinned (position: ${position}, height: ${height})`);
    assert.ok(/^(auto|scroll)$/.test(overflowY ?? ''), `control: the box scrolls its overflow (overflow-y: ${overflowY})`);

    const inside = descendants(box).filter(focusable);
    const reachable = focusable(box) || inside.length > 0;
    assert.ok(reachable,
      `the box (div.${[...box.classes].join('.')}, position: ${position}, height: ${height}, overflow-y: ${overflowY}) ` +
      `scrolls its overflow, but it has no tabindex and none of the ${descendants(box).length} elements inside it is a ` +
      `link, button, field or tabindex (it opens with "${label(box)}"). With focus on the page, the arrow keys, ` +
      `Page Down and Space scroll the page and never this box, so what it holds below the screen can't be ` +
      `scrolled to from the keyboard`);
  });
}
