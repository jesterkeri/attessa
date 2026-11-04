// Adversary round 40 on the site (2be81cb1..de0dbff). Intended home: site/test/no-js-seller-view-readable.test.mjs
// Run from the repo root: node --test site/test/no-js-seller-view-readable.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The site promises a readable page without JavaScript:
//   - site/src/static/assets/site.js:1 "Everything degrades to readable static HTML without it."
//   - site.css:281 and the r38/r39 fixes make every story step, walkthrough step, outcome, limit and claim
//     readable until a script has run.
// How it works ships its second tab panel already hidden in the static HTML:
//   how-it-works.html:100 `<div id="panel-seller" role="tabpanel" ... hidden>`
// and only site.js:105-126 (the tablist handler) can ever unhide it. With JavaScript off, all six seller
// steps ("Register your agent" to "Register the signer", the five built commands and their CLI lines)
// are display: none, the "Seller's view" tab button does nothing, and the page index entry
// "The seller's steps / 6 steps" (how-it-works.html:18) jumps to #views and shows nothing new.
// No site.css rule overrides [hidden] for the panel (only .menu[hidden] and .field-error[hidden] exist).
//
// The test evaluates the cascade with the round 38 harness, plus the UA rule `[hidden] { display: none }`
// (HTML Living Standard, Rendering, "Hidden elements"; not !important, so any author display rule beats
// it), for the page as it ships with <html class="no-js">, at desktop and phone widths.
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
      case 'hover': return v === (env.fine ? 'hover' : 'none');
      case 'pointer': return v === (env.fine ? 'fine' : 'coarse');
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
      if (/hidden|tabpanel|panel|walk|views/.test(r.sel)) throw new Error(`selector not supported by this test: ${r.sel}`);
      continue;
    }
    if (!m.ok) continue;
    const key = [r.decls[prop].important ? 1 : 0, ...m.spec, r.order];
    // Cascade order: !important, then specificity (a, b, c), then source order. Later wins ties.
    if (!best || lexGreaterOrEqual(key, best.key)) best = { key, val: r.decls[prop].val };
  }
  return best?.val;
}
// display: any author rule wins over the UA's [hidden] { display: none }; with none, [hidden] hides.
function display(el, env) {
  const author = computed(el, 'display', env);
  if (author !== undefined) return author;
  return 'hidden' in el.attrs ? 'none' : 'initial';
}
const notRendered = (el, env) => { for (let e = el; e; e = e.parent) if (display(e, env) === 'none') return e; return null; };
const within = (el, id) => { for (let a = el.parent; a; a = a.parent) if (a.attrs.id === id) return true; return false; };

const ENVS = [
  { name: 'desktop 1280x800', width: 1280, height: 800, reduce: false, fine: true },
  { name: 'phone 390x844', width: 390, height: 844, reduce: false, fine: false },
];

for (const env of ENVS) {
  test(`without JavaScript the How it works seller steps are rendered, not only the buyer's (${env.name})`, () => {
    const els = elements(page('how-it-works.html'));
    assert.ok(els[0].tag === 'html' && els[0].classes.has('no-js'), 'layout ships <html class="no-js">');
    const panels = els.filter(e => e.attrs.role === 'tabpanel');
    assert.deepEqual(panels.map(p => p.attrs.id), ['panel-buyer', 'panel-seller'], 'two tab panels');
    const steps = els.filter(e => 'data-walk-step' in e.attrs);
    const buyer = steps.filter(s => within(s, 'panel-buyer'));
    const seller = steps.filter(s => within(s, 'panel-seller'));
    assert.equal(buyer.length, 7, 'seven buyer steps (page index: "7 steps")');
    assert.equal(seller.length, 6, 'six seller steps (page index: "6 steps")');
    // Control: the buyer steps render, so the harness is not calling everything hidden.
    assert.deepEqual(buyer.filter(s => notRendered(s, env)), [], 'control: buyer steps render');
    const unseen = seller.map((s, i) => ({ step: i + 1, by: notRendered(s, env) })).filter(r => r.by)
      .map(r => ({ step: r.step, hiddenBy: `#${r.by.attrs.id ?? r.by.tag}${'hidden' in r.by.attrs ? '[hidden]' : ''}` }));
    assert.deepEqual(unseen, [], `seller steps a no-JS reader can't reach: ${JSON.stringify(unseen)}`);
  });
}
