// Adversary round 39 on the site (2be81cb1..1ae3254). Intended home: packages/site/test/scene-cdn-failure-readable.test.mjs
// Run from the repo root: node --test packages/site/test/scene-cdn-failure-readable.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The homepage's scroll scenes are driven by scene.js, a module whose first statement is
// `import * as THREE from 'three'`, mapped by layout.html:87 to cdn.jsdelivr.net. If that import fails
// (jsDelivr blocked by a network, an extension or an outage), scene.js never runs, but the inline script
// at layout.html:11 has already removed `no-js`.
//
// Commit 1ae3254 handled exactly this case for the story and the walkthrough, and states the rule:
//   site.css:281 "Steps stack and hide only once scene.js runs (is-live): without it, or if its CDN import
//   fails, all read in order."
//   site.js:1 "Everything degrades to readable static HTML without it."
// The other content scene.js drives still keys its fallback off `.no-js` only (site.css:461 to :463 and
// :560), so with JavaScript on and the CDN import failed, at 720px and wider:
//   - index.html outcomes: "Tampered and refused" and "Unapproved build" stay at opacity 0, blurred, under
//     the first outcome (site.css:349, grid-area 1 / 1);
//   - index.html spending limits: all four default rows stay at opacity 0 (site.css:452);
//   - index.html "What this proves, and what it doesn't": all ten claims stay at opacity 0 (site.css:554),
//     including "That the answer is correct." and "Protection when paying through buy.";
//   - use-cases.html: uses 2 to 4 stay at opacity 0.
// Screen readers still read them; sighted readers get blank space.
//
// The test evaluates site.css's cascade (the round 38 harness) for the elements as the static HTML ships
// them, in the state the page is in once the inline script ran but scene.js did not: no `no-js`, no
// `is-on` beyond what the HTML ships. A control check confirms the harness sees them all under `no-js`.
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
      if (/story-steps|walk|data-step|beat|spec|claims|data-at|\bli\b/.test(r.sel)) throw new Error(`selector not supported by this test: ${r.sel}`);
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

const ENVS = [
  { width: 1280, height: 800, reduce: false },
  { width: 1280, height: 800, reduce: true },
  { width: 1024, height: 768, reduce: false },
];

function hiddenOf(list, env) {
  return list.map(x => ({ what: x.what, opacity: +effectiveOpacity(x.el, env).toFixed(2), blur: blurred(x.el, env) }))
    .filter(r => r.opacity < 1 || r.blur);
}

// The items scene.js drives on a page (outcomes and uses [data-beat], limits and claims [data-at]),
// each labelled with its first heading, term or bold text for the report.
function scenedItems(name) {
  const html = page(name);
  const els = elements(html);
  assert.ok(els[0].tag === 'html' && els[0].classes.has('no-js'), 'layout ships <html class="no-js">');
  const labels = [...html.replace(/<!--[\s\S]*?-->/g, '')
    .matchAll(/<(?:li|div)\b[^>]*\s(?:data-beat(?=[\s>])|data-at=)[^>]*>[\s\S]*?<(?:h2|h3|dt|strong)>([^<]*)</g)].map(m => m[1].trim());
  const items = els.filter(e => 'data-beat' in e.attrs || 'data-at' in e.attrs);
  assert.equal(items.length, labels.length, 'one label per scene item');
  const htmlClasses = els[0].classes;
  return {
    items: items.map((el, i) => ({ el, what: labels[i] })),
    withoutJs: () => htmlClasses.add('no-js'),
    // The inline script at layout.html:11 removed no-js; scene.js never ran, so nothing added is-on.
    withJsSceneFailed: () => htmlClasses.delete('no-js'),
  };
}

for (const env of ENVS) {
  const tag = `${env.width}x${env.height}${env.reduce ? ', reduced motion' : ''}`;
  for (const name of ['index.html', 'use-cases.html']) {
    test(`${name}: with JavaScript on but the three.js CDN import failed, every outcome, limit and claim is visible (${tag})`, () => {
      const { items, withoutJs, withJsSceneFailed } = scenedItems(name);
      assert.ok(items.length >= 4, `${name} has scene-driven items`);
      withoutJs();
      assert.deepEqual(hiddenOf(items, env), [], 'control: under no-js the harness sees every item');
      withJsSceneFailed();
      const hidden = hiddenOf(items, env);
      assert.deepEqual(hidden, [], `${name} items a reader can't see when scene.js never ran: ${JSON.stringify(hidden)}`);
    });
  }
}
