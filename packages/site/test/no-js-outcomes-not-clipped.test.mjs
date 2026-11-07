// Adversary round 41 on the site (2be81cb1..2386d21). Intended home: packages/site/test/no-js-outcomes-not-clipped.test.mjs
// Run from the repo root: node --test packages/site/test/no-js-outcomes-not-clipped.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// site.js:1 promises "Everything degrades to readable static HTML without it", and site.css:463 says
// "Until scene.js runs (no JavaScript, or its three.js import failed) nothing drives the scenes, so show
// every outcome and limit." So in that state site.css:464 takes the three outcomes on the home page out of
// their shared grid cell (grid-area: auto) and stacks them, each 36px apart.
//
// But the box they stack in is still pinned: site.css:343 gives every .scene-sticky `height: 100svh` and
// `overflow: hidden`, and nothing undoes that at 720px and wider (only the phone rule at site.css:450 does).
// The story got its own unpinning for this state at site.css:284 to :285; the pinned scenes did not.
// So at desktop widths the outcomes section is a viewport-high window, centred (align-items: center), onto
// content taller than the viewport: the overflow is cut off at the top and the bottom, and since the box
// clips rather than scrolls, no scrolling reaches it.
//
// Measured on the built page (node packages/site/build.mjs at 2386d21), headless Chromium 1243 (playwright-core),
// 2026-11-04, every non-site request aborted, so fallback fonts. Offsets are from the top of the sticky box:
//   1280x800, JS off and JS on with the CDN failed: box 800 tall, content 1029.
//     "Three ways a call can end" (the h2) at -160 to -33: entirely cut off.
//     The lede at -3 to 99: its first line cut. "Unapproved build" at 730 to 963: most of it cut off.
//   1024x768: box 768, content 1037; h2 at -201 to -40, "Unapproved build" at 742 to 971.
//   1440x900: box 900, content 1123; h2 at -155 to 55, "Unapproved build" at 823 to 1057.
//   use-cases.html, 1280x800: box 800, content 1268. Use 1 "DeFi risk checks before lending" at -400 to
//     -89 and use 4 "Agents buying data or decisions" at 839 to 1202: both entirely out of sight, use 2
//     partly. 1440x900 and 1024x768 the same (use 1 ends at -52 and -85, use 4 starts at 902 and 803).
//   390x844, both pages: not clipped (site.css:450 unpins the scenes on phones).
// The three beats alone are taller than an 800px screen (about 234px each plus 36px gaps), so the
// display font loading would not make them fit.
//
// The test evaluates site.css's cascade (the round 38 and 39 harness) for the outcomes section as the static
// HTML ships it, in both states where scene.js never ran: it checks that the beats really are stacked in
// flow there (control), then that the box holding them is not a viewport-high box that hides overflow.
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

// ---- HTML: ancestor chains for elements, from a tag stack ----
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
function elements(html) {
  const out = [];
  const stack = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  for (const m of clean.matchAll(/<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g)) {
    const [whole, tagRaw, attrText, selfClose] = m;
    const tag = tagRaw.toLowerCase();
    if (whole.startsWith('</')) {
      const i = stack.map(e => e.tag).lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    const attrs = {};
    for (const a of attrText.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    const el = { tag, attrs, classes: new Set((attrs.class ?? '').split(/\s+/).filter(Boolean)), parent: stack.at(-1) ?? null };
    out.push(el);
    if (!VOID.has(tag) && !selfClose) stack.push(el);
  }
  return out;
}

// ---- CSS: rules with their media context ----
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
      else if (prelude.startsWith('@')) { /* @keyframes, @supports etc: not used for these props */ }
      else {
        const decls = {};
        for (const d of inner.split(';')) {
          const k = d.indexOf(':');
          if (k < 0) continue;
          const prop = d.slice(0, k).trim().toLowerCase();
          let val = d.slice(k + 1).trim();
          const important = /!important\s*$/.test(val);
          val = val.replace(/!important\s*$/, '').trim();
          decls[prop] = { val, important };
        }
        // Shorthands this test reads: overflow-y follows overflow unless set on its own.
        if (decls.overflow && !decls['overflow-y']) decls['overflow-y'] = { ...decls.overflow, val: decls.overflow.val.split(/\s+/).at(-1) };
        for (const sel of splitTop(prelude)) out.push({ sel: sel.trim(), media, decls, order: order++ });
      }
      i = j;
    }
  };
  parse(s, []);
  return out;
}
function splitTop(s) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && !depth) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
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
      case 'prefers-reduced-motion': return v === (env.reduce ? 'reduce' : 'no-preference');
      case 'hover': return v === 'hover';
      case 'pointer': return v === 'fine';
      default: throw new Error(`unsupported media feature: ${feat}`);
    }
  }));
}

// ---- Selectors: compounds joined by descendant or child combinators ----
function parseSelector(sel) {
  const tokens = sel.replace(/\s*>\s*/g, ' > ').trim().split(/\s+/);
  const parts = [];
  let comb = ' ';
  for (const t of tokens) { if (t === '>') { comb = '>'; continue; } parts.push({ comb, compound: t }); comb = ' '; }
  return parts;
}
function matchCompound(c, el) {
  let spec = [0, 0, 0];
  let rest = c;
  if (/::/.test(rest)) return { ok: false, spec, pseudoElement: true };
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
      if (/^(first-child|last-child|nth-child)/.test(m[1])) return { unsupported: true };
      ok = false;
    }
    else return { unsupported: true };
    rest = rest.slice(m[0].length);
  }
  return { ok, spec };
}
function matchSelector(sel, el) {
  const parts = parseSelector(sel);
  let spec = [0, 0, 0];
  const last = parts.at(-1);
  const r = matchCompound(last.compound, el);
  if (r.unsupported) return { unsupported: true };
  if (!r.ok) return { ok: false };
  spec = spec.map((n, i) => n + r.spec[i]);
  let cur = el;
  for (let k = parts.length - 2; k >= 0; k--) {
    const comb = parts[k + 1].comb;
    let found = null;
    for (let a = cur.parent; a; a = comb === '>' ? null : a.parent) {
      const rr = matchCompound(parts[k].compound, a);
      if (rr.unsupported) return { unsupported: true };
      if (rr.ok) { found = a; spec = spec.map((n, i) => n + rr.spec[i]); break; }
      if (comb === '>') break;
    }
    if (!found) return { ok: false };
    cur = found;
  }
  return { ok: true, spec };
}

const RULES = rules(css);
const lexGreaterOrEqual = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };
function computed(el, prop, env) {
  let best = null;
  for (const r of RULES) {
    if (!(prop in r.decls) || !mediaMatches(r.media, env)) continue;
    const m = matchSelector(r.sel, el);
    if (m.unsupported) {
      // Never drop a rule that could decide the answer: refuse to judge instead.
      if (/scene-sticky|scene-sec|outcomes|beat|\bwrap\b/.test(r.sel)) throw new Error(`selector not supported by this test: ${r.sel}`);
      continue;
    }
    if (!m.ok) continue;
    const key = [r.decls[prop].important ? 1 : 0, ...m.spec, r.order];
    if (!best || lexGreaterOrEqual(key, best.key)) best = { key, val: r.decls[prop].val };
  }
  return best?.val;
}

// Desktop and tablet widths, where the scenes pin (site.css:448 unpins them below 720px).
const ENVS = [
  { width: 1440, height: 900, reduce: false },
  { width: 1280, height: 800, reduce: false },
  { width: 1280, height: 800, reduce: true },
  { width: 1024, height: 768, reduce: false },
];
const STATES = {
  'without JavaScript': classes => classes.add('no-js'),
  // The inline script at layout.html:11 removed no-js; scene.js never ran, so nothing added scene-live.
  'with JavaScript on but the three.js CDN import failed': classes => classes.delete('no-js'),
};

// Each pinned scene whose beats site.css stacks once scene.js didn't run.
const SCENES = [
  { name: 'index.html', sec: 'outcomes', count: 3, what: 'the three outcomes', lost: 'the heading "Three ways a call can end" and most of "Unapproved build"' },
  { name: 'use-cases.html', sec: 'uses', count: 4, what: 'the four use cases', lost: 'all of "DeFi risk checks before lending" and "Agents buying data or decisions"' },
];

for (const env of ENVS) {
  const tag = `${env.width}x${env.height}${env.reduce ? ', reduced motion' : ''}`;
  for (const sc of SCENES) for (const [state, apply] of Object.entries(STATES)) {
    test(`${sc.name} ${state}: ${sc.what}, shown stacked, are not clipped by a viewport-high pinned box (${tag})`, () => {
      const els = elements(page(sc.name));
      assert.ok(els[0].tag === 'html' && els[0].classes.has('no-js'), 'layout ships <html class="no-js">');
      apply(els[0].classes);
      assert.ok(!els[0].classes.has('scene-live'), 'scene.js never ran');

      const beats = els.filter(e => 'data-beat' in e.attrs && (() => { for (let a = e.parent; a; a = a.parent) if (a.attrs['data-scene-sec'] === sc.sec) return true; return false; })());
      assert.equal(beats.length, sc.count, `${sc.name} has ${sc.what}`);

      // Control: in this state site.css stacks every beat in flow instead of in one shared cell.
      for (const b of beats) assert.equal(computed(b, 'grid-area', env), 'auto', 'each beat is stacked in flow (site.css:464)');

      let box = beats[0].parent;
      while (box && !box.classes.has('scene-sticky')) box = box.parent;
      assert.ok(box, 'the beats sit in a .scene-sticky box');
      const got = {
        position: computed(box, 'position', env),
        height: computed(box, 'height', env),
        overflowY: computed(box, 'overflow-y', env),
      };
      const viewportHigh = /^\d+(\.\d+)?(s|d|l)?vh$/.test(got.height ?? '');
      const clips = ['hidden', 'clip'].includes(got.overflowY);
      assert.ok(!(viewportHigh && clips),
        `${sc.what}, stacked, sit in a box ${got.height} high that hides its overflow (${JSON.stringify(got)}), ` +
        `so whatever is taller than the screen, ${sc.lost} included, is cut off and no scrolling reaches it`);
    });
  }
}
