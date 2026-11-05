// Adversary round 51 on the site (2be81cb..d384d27). Intended home: site/test/code-block-keyboard-scrolls.test.mjs
// Run from the repo root: node --test site/test/code-block-keyboard-scrolls.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// site/README.md:104 (r50 fix): "A box that scrolls with nothing focusable inside (the story, the outcomes, the
// uses) has `tabindex="0"`, so the keyboard can scroll it." Round 50 (pinned-box-keyboard-scrolls.test.mjs) held
// the site to WCAG 2.2 SC 2.1.1 Keyboard (A; axe rule scrollable-region-focusable): Safari never makes a scroller
// focusable on its own, so a box that scrolls must be focusable or hold something focusable. Earlier rounds hold
// the site to the README widths (390px phone, README.md:109) and to 200% zoom on a laptop (a 1440x900 screen lays
// out at 720x450 CSS px, a 1280x800 one at 640x400).
//
// The docs code blocks are boxes of the same kind. site.css:524 gives every `.code pre` `overflow-x: auto`, and
// a plain `.code` figure (not `.is-output`, site.css:525) keeps the UA's `white-space: pre`, so a line longer than
// the column scrolls sideways inside the <pre>. None of those <pre>s has a tabindex or holds a link, button or
// field (the Copy button sits in the figcaption, outside the scroller, and copies the text without showing it).
// With focus on the page, ArrowRight and End move nothing; the line ends stay out of sight for a keyboard user.
//
// Measured on the built pages (adv-site-r51 worktree at d384d27, dist as built), headless Chromium 153.0.8010.12
// (playwright-core), 2026-11-05, every non-site request aborted (fallback fonts), probe/scrollers.mjs and
// probe/pretab.mjs beside this file:
//   720x450 (1440x900 at 200%), docs/how-to.html: "Seller commands" <pre> scrolls 384px; the "Use it with buy"
//     example output <pre> scrolls 993px (its "Price: 0.005 USDC ... you pay even if the answer fails it.
//     [pay/cancel]" line is the warning that a buy call isn't protected). docs/tutorial.html: the `attessa init`
//     block scrolls 300px. Focus outside, ArrowRight x2 + End: scrollLeft stays 0 on each.
//   390x844, docs/tutorial.html: four <pre>s scroll 158, 590, 127 and 143px; docs/how-to.html three, 674, 151 and
//     1283px. (docs/reference.html's four .table-wrap tables, overflow-x: auto at site.css:943 with no link inside,
//     scroll 72, 209, 18 and 322px at 390 too; this test checks the code blocks only.)
//   Chromium 153 gives each such <pre> an unnamed implicit tab stop; Safari gives none.
//
// The test does not need a browser. It evaluates site.css's cascade (the round 38 to 50 harness) for each <pre>
// on every page as shipped, takes its longest line, and computes the narrowest the box's content can be: the
// line in a 0.6em monospace (Geist Mono's advance, and a floor for common fallbacks) at the <pre>'s font size.
// It compares that with the screen width minus the <pre>'s own padding, an upper bound for the box. A line
// wider than that must scroll, so the box must be reachable from the keyboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(src, 'static', 'assets', 'site.css'), 'utf8');
const layout = readFileSync(join(src, 'layout.html'), 'utf8');
const page = file => {
  const raw = readFileSync(file, 'utf8');
  const meta = Object.fromEntries([...raw.matchAll(/^<!--\s*(\w+):\s*(.*?)\s*-->\s*$/gm)].map(m => [m[1], m[2]]));
  const body = raw.replace(/^<!--\s*\w+:.*?-->\s*\r?\n/gm, '')
    .replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, p) => readFileSync(join(src, 'partials', `${p}.html`), 'utf8'));
  return layout.replace('{{content}}', () => body).replace(/\{\{bodyClass\}\}/g, meta.body ?? '');
};
const pagesDir = join(src, 'pages');
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.html') ? [p] : []; });

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
// A selector this harness can't read is fatal only if its subject could be a <pre> or <code> (or any element).
const relevantSubject = sel => {
  const subj = parseSelector(sel).at(-1).compound;
  if (/::/.test(subj)) return false;
  const tag = subj.match(/^([a-zA-Z][\w-]*)/)?.[1];
  return !tag || tag === 'pre' || tag === 'code';
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
// Inherited properties: the nearest ancestor that sets one, else the UA default.
const UA_WS = { pre: 'pre', textarea: 'pre-wrap' };
function whiteSpace(el, env) {
  for (let e = el; e; e = e.parent) {
    const v = computed(e, 'white-space', env);
    if (v && v !== 'inherit') return v;
    if (UA_WS[e.tag]) return UA_WS[e.tag];
  }
  return 'normal';
}
function fontPx(el, env) {
  for (let e = el; e; e = e.parent) {
    const v = computed(e, 'font-size', env) ?? (computed(e, 'font', env)?.match(/(\d*\.?\d+(?:rem|px|em))(?:\/\S+)?\s+(?:var\(|[\w"'])/)?.[1]);
    if (!v) continue;
    const m = v.match(/^(\d*\.?\d+)(rem|px)$/);
    if (!m) throw new Error(`font-size this test can't read: ${v}`);
    return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
  }
  return 16;
}
const padX = (el, env) => {
  const v = computed(el, 'padding', env);
  if (!v) return 0;
  const p = words(v).map(x => parseFloat(x) || 0);
  return (p[1] ?? p[0]) + (p[3] ?? p[1] ?? p[0]);
};
const focusable = el => {
  const ti = el.attrs.tabindex;
  if (ti !== undefined && ti.trim() !== '') return Number(ti) >= 0;
  if ('disabled' in el.attrs && /^(button|input|select|textarea)$/.test(el.tag)) return false;
  if (el.tag === 'a' || el.tag === 'area') return 'href' in el.attrs;
  if (el.tag === 'input') return el.attrs.type !== 'hidden';
  return /^(button|select|textarea|summary|iframe)$/.test(el.tag) || ('contenteditable' in el.attrs && el.attrs.contenteditable !== 'false');
};
const descendants = el => el.children.flatMap(c => [c, ...descendants(c)]);
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, 'x');
const EM = 0.6; // monospace advance, in em

const ENVS = [
  { name: '390px phone (README.md:109)', width: 390, height: 844, touch: true, motion: 'no-preference' },
  { name: '1440x900 screen at 200% zoom', width: 720, height: 450, touch: false, motion: 'no-preference' },
  { name: '1280x800 screen at 200% zoom', width: 640, height: 400, touch: false, motion: 'no-preference' },
];

for (const env of ENVS) {
  test(`${env.name} (${env.width}px CSS): every code block whose lines must scroll sideways can be reached from the keyboard`, () => {
    const bad = [];
    let scrollers = 0;
    for (const file of walk(pagesDir)) {
      const els = elements(page(file));
      for (const pre of els.filter(e => e.tag === 'pre')) {
        const ox = computed(pre, 'overflow-x', env) ?? computed(pre, 'overflow', env);
        if (!/^(auto|scroll)/.test(ox ?? '')) continue;
        // The element that holds the text: a lone <code> inside the <pre>, else the <pre>.
        const holder = pre.children.length === 1 && pre.children[0].tag === 'code' ? pre.children[0] : pre;
        const ws = whiteSpace(holder, env);
        if (!/^(pre|nowrap)$/.test(ws)) continue;
        const lines = decode(pre.text.replace(/\{\{[^}]*\}\}/g, '')).split('\n');
        const longest = lines.reduce((a, b) => ([...b].length > [...a].length ? b : a), '');
        const need = [...longest].length * EM * fontPx(holder, env);
        const room = env.width - padX(pre, env);
        if (need <= room) continue;
        scrollers++;
        const reachable = focusable(pre) || descendants(pre).some(focusable);
        if (!reachable) bad.push(`${relative(pagesDir, file)}: <pre> (white-space: ${ws}, overflow-x: ${ox}) with a ${[...longest].length}-character line, at least ${Math.round(need)}px wide in a box at most ${room}px: "${longest.trim().slice(0, 70)}"`);
      }
    }
    // Control: the pages ship code blocks that must scroll at this width (if none do, this test no longer applies).
    assert.ok(scrollers > 0, `control: some <pre> must scroll at ${env.width}px`);
    assert.deepEqual(bad, [],
      `${bad.length} of the ${scrollers} code blocks that must scroll sideways at ${env.width}px have no tabindex and ` +
      `hold no link, button or field, so with focus on the page ArrowRight and End scroll nothing and the ends of ` +
      `their lines can't be brought into view from the keyboard (README.md:104: "A box that scrolls with nothing ` +
      `focusable inside ... has tabindex=\\"0\\", so the keyboard can scroll it"):\n  ${bad.join('\n  ')}`);
  });
}
