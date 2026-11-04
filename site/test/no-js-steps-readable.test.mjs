// Adversary round 38 on the site (2be81cb1..367fa6a). Intended home: site/test/no-js-steps-readable.test.mjs
// Run from the repo root: node --test site/test/no-js-steps-readable.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The site promises a readable page without JavaScript:
//   - site/src/static/assets/site.js:1 "Everything degrades to readable static HTML without it."
//   - site/src/static/assets/site.css:457 "Without JavaScript nothing drives the scenes, so show every
//     outcome and limit." (followed by `.no-js .beat`, `.no-js .spec [data-at]` and, at :556,
//     `.no-js .proves-sec .claims li[data-at]` overrides)
//   - layout.html:2 ships `<html class="no-js">` and only an inline script removes it.
//
// Two scroll-driven lists were left out of those overrides:
//   1. Homepage story (index.html `<li data-step>`): site.css:281 gives every `.story-steps li`
//      `opacity: 0; filter: blur(4px)` and only scene.js (a module that statically imports three from
//      jsDelivr) adds `is-on`. Without JS, steps 2 to 5 are invisible, including step 5, the only
//      homepage text that says a tampering gateway can still settle (paid_but_rejected; see
//      OPEN-QUESTIONS "site adversary r35, r36", THREAT-MODEL TB1, KNOWN-LIMITS L1).
//   2. How it works walkthrough: site.css:678 gives `.walk-copy` and `.walk-step .term` `opacity: 0.3`
//      above 900px; only site.js adds `is-on`. Without JS every step's text sits at about 1.6:1
//      contrast, under WCAG 2.2 SC 1.4.3's 4.5:1.
//
// The test evaluates site.css's cascade (specificity, order, !important, @media at a 1280x800 desktop)
// for the elements as the static HTML ships them, with <html class="no-js">.
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
  const body = raw.replace(/^<!--\s*\w+:.*?-->\s*\r?\n/gm, '');
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
// Returns { ok, spec } or { unsupported: true }.
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
      // Dynamic or structural pseudo-classes: treated as not matching a static, unhovered element.
      // first-child/last-child/nth-child are left unsupported so no rule is silently dropped.
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
      if (/story-steps|walk|data-step|\bli\b/.test(r.sel)) throw new Error(`selector not supported by this test: ${r.sel}`);
      continue;
    }
    if (!m.ok) continue;
    const key = [r.decls[prop].important ? 1 : 0, ...m.spec, r.order];
    // Cascade order: !important, then specificity (a, b, c), then source order. Later wins ties.
    if (!best || lexGreaterOrEqual(key, best.key)) best = { key, val: r.decls[prop].val };
  }
  return best?.val;
}
// Opacity multiplies down the tree.
function effectiveOpacity(el, env) {
  let o = 1;
  for (let e = el; e; e = e.parent) { const v = computed(e, 'opacity', env); if (v !== undefined) o *= parseFloat(v); }
  return o;
}
function blurred(el, env) {
  for (let e = el; e; e = e.parent) { const v = computed(e, 'filter', env); if (v && /blur\(\s*[1-9]/.test(v)) return v; }
  return null;
}

const vars = Object.fromEntries([...css.match(/:root\s*\{([\s\S]*?)\}/)[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const hex = v => { const h = v.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lum = rgb => { const c = rgb.map(x => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const blend = (fg, bg, a) => fg.map((c, i) => c * a + bg[i] * (1 - a));

const DESKTOP = { width: 1280, height: 800, reduce: false };
const DESKTOP_REDUCED = { width: 1280, height: 800, reduce: true };

for (const env of [DESKTOP, DESKTOP_REDUCED]) {
  test(`without JavaScript every homepage story step is visible and unblurred (1280x800${env.reduce ? ', reduced motion' : ''})`, () => {
    const els = elements(page('index.html'));
    assert.ok(els[0].tag === 'html' && els[0].classes.has('no-js'), 'layout ships <html class="no-js">');
    const steps = els.filter(e => e.tag === 'li' && 'data-step' in e.attrs);
    assert.equal(steps.length, 5, 'five story steps in index.html');
    const report = steps.map((s, i) => ({ step: i + 1, opacity: +effectiveOpacity(s, env).toFixed(2), blur: blurred(s, env), position: computed(s, 'position', env) }));
    const hidden = report.filter(r => r.opacity < 1 || r.blur);
    assert.deepEqual(hidden, [], `story steps a no-JS reader can't see: ${JSON.stringify(hidden)}`);
    const stacked = report.filter(r => r.position === 'absolute');
    assert.ok(stacked.length <= 1, `visible steps stacked on top of each other (position: absolute): ${JSON.stringify(stacked)}`);
  });
}

test('without JavaScript the How it works walkthrough text meets 4.5:1 contrast (1280x800)', () => {
  const els = elements(page('how-it-works.html'));
  const copies = els.filter(e => e.classes.has('walk-copy'));
  assert.ok(copies.length >= 13, 'buyer (7) and seller (6) walkthrough steps');
  const bg = hex(vars['--bg']);
  const fg = hex(vars['--text-2']); // .walk-copy p { color: var(--text-2) }
  const low = copies.map((c, i) => {
    const o = effectiveOpacity(c, DESKTOP);
    return { step: i + 1, opacity: +o.toFixed(2), contrast: +contrast(blend(fg, bg, o), bg).toFixed(2) };
  }).filter(r => r.contrast < 4.5);
  assert.deepEqual(low, [], `walkthrough steps under 4.5:1 without JS: ${JSON.stringify(low)}`);
});
