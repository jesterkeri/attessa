// Adversary round 47 on the site (2be81cb1..968df52). Intended home: site/test/use-cases-headings-fit-phone.test.mjs
// Run from the repo root: node --test site/test/use-cases-headings-fit-phone.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// site/README.md:109 says the site was "Checked in a desktop browser at 390, 768, 834, 1024, 1280, 1366 and
// 1440px wide", and site.js:1 promises readable static HTML. On Use cases, each of the four uses is an
// <li class="beat use"> in <ol class="beats uses"> (use-cases.html:30 to 55) headed by an <h2>. At 390px:
//   - site.css:869 sets .use h2 to clamp(2.2rem, 1rem + 3vw, 4.2rem) = 35.2px, and site.css:66 sets every h2
//     uppercase, weight 780, font-stretch 64%, with nothing that lets a word break (no overflow-wrap,
//     word-break or hyphens anywhere up the tree).
//   - The longest word, "RECOMMENDATIONS" in "Yield or route recommendations" (use-cases.html:39), is wider than
//     the 350px the column has (390 less two 20px gutters) in any sans-serif fallback that has no width axis.
//   - .beats (site.css:355) is a grid with one implicit auto column, so that column grows to the word: it is
//     403.25px wide in a 350px list, and every heading, paragraph and "What the proof adds" line in all four
//     uses is laid out 403px wide. main clips overflow-x (site.css:80), so the last 33px of each line is cut
//     off: "to score a", "the selle", "the operat", "RECOMMENDATION".
// The rules involved don't depend on no-js or scene-live, so it holds in all three states (no JavaScript, CDN
// import failed, everything working). It needs only that Anybody, the display face from Google Fonts, is not
// there: when Google Fonts is blocked or unreachable (privacy.html:20 names it as a third party the page loads
// from), and on every first visit until it arrives, since the stylesheet asks for display=swap
// (layout.html:14). The font stack's fallbacks ("Geist", ui-sans-serif, sans-serif) come from the same
// request or are system faces.
// Measured on the built page (adv-site-r47 worktree at 968df52, dist as built), headless Chromium 1243
// (playwright-core), 2026-11-05, every non-site request aborted, fallback face DejaVu Sans Bold: the word is
// 403.3px, the li 20 to 423px, the paragraph text reaches 389.7px of a 390px screen; a screenshot shows the
// line ends cut off. Probes: probe/uses.mjs, probe/why.mjs, probe/word.mjs, probe/offright.mjs beside this file
// (offright, CDN-failed state, 390 and 768px, all twelve pages: use-cases.html at 390px is the only page hit).
//
// The test does not need a browser. It evaluates site.css's cascade (the round 38 to 42 harness) for the
// heading as the page ships it at 390px, and measures each heading's longest unbreakable run with
// Helvetica-Bold's advance widths (Adobe AFM, 1/1000 em; Arial Bold and Liberation Sans Bold share them).
// That is the sans-serif Chrome falls back to on macOS (Helvetica) and Windows (Arial); the DejaVu Sans Bold
// measured above is wider still. A word fits if it is no wider than the column, or if the cascade lets it
// break (overflow-wrap: anywhere or break-word, word-break: break-all or break-word, or hyphens: auto).
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
    const el = { tag, attrs, classes: new Set((attrs.class ?? '').split(/\s+/).filter(Boolean)), parent: stack.at(-1) ?? null, text: '' };
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
// The size in a `font` shorthand: the token before an optional /line-height, ahead of the family list.
const fontSizeOf = font => splitTop(font, ',')[0].match(/(?:^|\s)((?:clamp|min|max|calc)\([^]*?\)|[\d.]+(?:px|rem|em|vw|%))(?:\/\S+)?(?=\s)/)?.[1];
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
        for (const d of splitTop(inner, ';')) {
          const k = d.indexOf(':');
          if (k < 0) continue;
          const prop = d.slice(0, k).trim().toLowerCase();
          let val = d.slice(k + 1).trim();
          const important = /!important\s*$/.test(val);
          val = val.replace(/!important\s*$/, '').trim();
          decls[prop] = { val, important };
        }
        // Shorthands this test reads as longhands.
        if (decls.font && !decls['font-size']) { const fs = fontSizeOf(decls.font.val); if (fs) decls['font-size'] = { ...decls.font, val: fs }; }
        if (decls['word-wrap'] && !decls['overflow-wrap']) decls['overflow-wrap'] = decls['word-wrap'];
        if (decls.padding && !decls['padding-left']) { const p = splitTop(decls.padding.val, ' ').filter(Boolean); decls['padding-left'] = { ...decls.padding, val: p[3] ?? p[1] ?? p[0] }; decls['padding-right'] = { ...decls.padding, val: p[1] ?? p[0] }; }
        if (decls['padding-inline'] && !decls['padding-left']) { const p = splitTop(decls['padding-inline'].val, ' ').filter(Boolean); decls['padding-left'] = { ...decls['padding-inline'], val: p[0] }; decls['padding-right'] = { ...decls['padding-inline'], val: p[1] ?? p[0] }; }
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
      case 'prefers-reduced-motion': return v === 'no-preference';
      case 'hover': return v === (env.touch ? 'none' : 'hover');
      case 'pointer': return v === (env.touch ? 'coarse' : 'fine');
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
  if (/::/.test(rest)) return { ok: false, spec };
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
  const r = matchCompound(parts.at(-1).compound, el);
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
// A selector this harness can't read is fatal only if its subject could be one of the elements measured here.
const RELEVANT = /(^|[\s>])(h2|li|ol|div|html)?(\.(use|uses|beat|beats|wrap|scene-grid|scene-copy|scene-sticky|uses-sec)\b|:root)|(^|[\s>])h2\b/;
function computed(el, prop, env) {
  let best = null;
  for (const r of RULES) {
    if (!(prop in r.decls) || !mediaMatches(r.media, env)) continue;
    const m = matchSelector(r.sel, el);
    if (m.unsupported) {
      if (RELEVANT.test(parseSelector(r.sel).at(-1).compound)) throw new Error(`selector not supported by this test: ${r.sel}`);
      continue;
    }
    if (!m.ok) continue;
    const key = [r.decls[prop].important ? 1 : 0, ...m.spec, r.order];
    if (!best || lexGreaterOrEqual(key, best.key)) best = { key, val: r.decls[prop].val };
  }
  return best?.val;
}
const INHERITED = new Set(['overflow-wrap', 'word-wrap', 'word-break', 'hyphens', 'white-space', 'letter-spacing', 'text-transform', 'font-size']);
function get(el, prop, env) {
  if (!INHERITED.has(prop)) return computed(el, prop, env);
  for (let a = el; a; a = a.parent) { const v = computed(a, prop, env); if (v !== undefined && v !== 'inherit') return { val: v, on: a }; }
  return undefined;
}

// ---- Lengths ----
const ROOT_FS = 16;
function px(v, { em, env, vars = {} }) {
  v = v.trim().replace(/var\((--[\w-]+)\)/g, (_, n) => { if (!(n in vars)) throw new Error(`unknown ${n}`); return vars[n]; });
  let m;
  if ((m = v.match(/^max\((.*)\)$/))) return Math.max(...splitTop(m[1], ',').filter(p => !/env\(/.test(p)).map(p => px(p, { em, env, vars })));
  if ((m = v.match(/^min\((.*)\)$/))) return Math.min(...splitTop(m[1], ',').map(p => px(p, { em, env, vars })));
  if ((m = v.match(/^clamp\((.*)\)$/))) { const [lo, mid, hi] = splitTop(m[1], ',').map(p => px(p, { em, env, vars })); return Math.min(hi, Math.max(lo, mid)); }
  if ((m = v.match(/^calc\((.*)\)$/))) return px(m[1], { em, env, vars });
  const terms = splitTop(v, ' ').filter(Boolean);
  if (terms.length > 1) {
    let sum = px(terms[0], { em, env, vars });
    for (let i = 1; i < terms.length; i += 2) {
      if (!['+', '-'].includes(terms[i])) throw new Error(`length not supported by this test: ${v}`);
      sum += (terms[i] === '+' ? 1 : -1) * px(terms[i + 1], { em, env, vars });
    }
    return sum;
  }
  if (v === '0') return 0;
  if ((m = v.match(/^(-?[\d.]+)(px|rem|em|vw)$/))) {
    const n = parseFloat(m[1]);
    return m[2] === 'px' ? n : m[2] === 'rem' ? n * ROOT_FS : m[2] === 'em' ? n * em : n * env.width / 100;
  }
  throw new Error(`length not supported by this test: ${v}`);
}

// Helvetica-Bold advance widths, 1/1000 em (Adobe Core 14 AFM; Arial Bold and Liberation Sans Bold match).
const HB = {
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278, m: 889,
  n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
  '-': 333, "'": 278, ',': 278, '.': 278,
};
const advance = ch => { if (!(ch in HB)) throw new Error(`no advance width for ${JSON.stringify(ch)}`); return HB[ch]; };

// 390px is the narrowest width README.md:109 says was checked: a phone (touch, overlay scrollbars).
const ENV = { width: 390, height: 844, touch: true };
const STATES = {
  'without JavaScript': classes => classes.add('no-js'),
  'with JavaScript on but a CDN import failed': classes => classes.delete('no-js'),
  'with everything working': classes => { classes.delete('no-js'); classes.add('scene-live'); },
};

for (const [state, apply] of Object.entries(STATES)) {
  test(`use-cases.html ${state}, ${ENV.width}px wide, display face not loaded: every use's heading fits its column, so no line of the four uses runs past the screen edge`, () => {
    const els = elements(page('use-cases.html'));
    const html = els[0];
    assert.ok(html.tag === 'html' && html.classes.has('no-js'), 'layout ships <html class="no-js">');
    apply(html.classes);

    const list = els.find(e => e.tag === 'ol' && e.classes.has('beats') && e.classes.has('uses'));
    assert.ok(list, 'use-cases.html has <ol class="beats uses">');
    const heads = els.filter(e => e.tag === 'h2' && e.parent?.classes.has('use') && e.parent.parent === list);
    assert.equal(heads.length, 4, 'control: four uses, each with an h2');

    // Width the column gives the list: the .wrap's content box, in one column at this width.
    const grid = (() => { for (let a = list.parent; a; a = a.parent) if (a.classes.has('scene-grid')) return a; return null; })();
    assert.ok(grid && grid.classes.has('wrap'), 'the list sits in a .wrap.scene-grid');
    const vars = { '--gutter': computed(html, '--gutter', ENV) };
    const pl = px(computed(grid, 'padding-left', ENV), { em: ROOT_FS, env: ENV, vars });
    const pr = px(computed(grid, 'padding-right', ENV), { em: ROOT_FS, env: ENV, vars });
    const cols = splitTop(computed(grid, 'grid-template-columns', ENV), ' ').filter(Boolean);
    assert.equal(cols.length, 1, `control: .scene-grid is one column at ${ENV.width}px (got ${cols.join(' ')})`);
    const available = ENV.width - pl - pr;

    const problems = [];
    for (const h of heads) {
      const fsDecl = get(h, 'font-size', ENV);
      const fs = px(fsDecl.val, { em: ROOT_FS, env: ENV, vars });
      const upper = get(h, 'text-transform', ENV)?.val === 'uppercase';
      const ls = px(get(h, 'letter-spacing', ENV)?.val ?? '0', { em: fs, env: ENV, vars });
      const ow = get(h, 'overflow-wrap', ENV)?.val ?? 'normal';
      const wb = get(h, 'word-break', ENV)?.val ?? 'normal';
      const hy = get(h, 'hyphens', ENV)?.val ?? 'manual';
      if (/^(anywhere|break-word)$/.test(ow) || /^(break-all|break-word)$/.test(wb) || hy === 'auto') continue;
      const text = h.text.replace(/&#x20AE;/g, 'T').replace(/&amp;/g, '&').trim();
      // Break opportunities: spaces, and after a hyphen.
      const runs = text.split(/\s+/).flatMap(w => w.split(/(?<=-)/)).filter(Boolean);
      for (const run of runs) {
        const shown = upper ? run.toUpperCase() : run;
        const width = [...shown].reduce((s, ch) => s + advance(ch) * fs / 1000 + ls, 0);
        if (width > available + 0.5) problems.push(`"${shown}" in "${text}" is ${width.toFixed(1)}px at ${fs}px`);
      }
    }
    assert.deepEqual(problems, [],
      `the column is ${available}px at ${ENV.width}px, but ${problems.join('; ')}, and nothing lets it break. ` +
      `.beats has one implicit auto grid column (site.css:355), so it grows to that word and lays every heading, ` +
      `paragraph and "What the proof adds" line of all four uses out that wide; main (overflow-x: clip) cuts off their line ends`);
  });
}
