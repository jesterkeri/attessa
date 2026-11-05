// Adversary round 52 on the site (2be81cb..95842f4). Intended home: site/test/code-block-focus-ring-visible.test.mjs
// Run from the repo root: node --test site/test/code-block-focus-ring-visible.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// Round 51's fix (28620fb) made every docs code block a tab stop, `<pre tabindex="0">`, so the keyboard can
// scroll it sideways (site/README.md:104). A tab stop has to show where focus is: the brief for these rounds
// counts "lost or obscured focus" as an accessibility failure, and round 50's fix for the same kind of tab stop
// (the pinned boxes, which clip their own outline) drew their ring inside the box, site.css:352
// `.story-sticky:focus-visible, .scene-sticky:focus-visible { outline-offset: -3px; }`.
//
// The docs code blocks got no such rule. A focused <pre> takes the site-wide ring, site.css:52
// `:focus-visible { outline: 1.5px solid var(--text); outline-offset: 3px; }`, which is drawn 3 to 4.5px
// outside the <pre>. But its figure clips: site.css:932 `.docs-main .code { ... overflow: hidden; }`, with no
// padding, and the <pre> (site.css:524, `margin: 0`) is the figure's last child and fills it edge to edge. So
// the ring's left, right and bottom sides fall outside the figure's padding box and are cut away. Only its top
// side survives, as one line inside the figcaption, 3px above the caption's own hairline divider, where it
// reads as the divider getting brighter rather than as a ring round the code.
//
// Measured on the built pages (adv-site-r52 worktree at 95842f4, dist as built), headless Chromium
// (playwright-core, chrome-headless-shell 1243), 2026-11-05, every non-site request aborted, probe/prering.mjs
// and probe/figshot.mjs beside this file (focus the Copy button, press Tab: activeElement is the <pre>,
// :focus-visible true, outline "solid 1px rgb(237, 237, 238) off 3px"; screenshot diff of the block before and
// after, pixels changed per side of the <pre>):
//   390x844, docs/how-to.html, all four blocks: top 347, right 0, bottom 0, left 1 (the clip is the FIGURE.code
//     rect, e.g. [20,314,370,544] round a <pre> at [21,369,369,543]).
//   720x450 (1440x900 at 200%), docs/tutorial.html, four of five blocks: top 637, right 0, bottom 0, left 1;
//     docs/reference.html's payAndVerify block the same.
//   For comparison, reference.html's `.table-wrap` tab stops (no clipping parent) draw all four sides
//     (left 445, right 450 changed pixels on a table taller than the screen).
//
// The test needs no browser. It evaluates site.css's cascade (round 51's harness, copied) for every element on
// every page that is a tab stop because of `tabindex="0"` on a non-interactive element (the r50 and r51 tab-stop
// scrollers), in its :focus-visible state, and asks: when its parent clips (overflow hidden or clip) and the
// element sits flush against the parent's padding box on a side, does the ring stay inside on that side? It
// does if outline-offset + outline-width <= the parent's padding plus the element's margin on that side. Any
// fix passes: an inset ring for these blocks, a figure that doesn't clip, or room round the <pre>.
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
    // Round 52: the keyboard-focused element (STATE.focused) matches :focus and :focus-visible; its ancestors
    // match :focus-within. Every other state pseudo-class is off.
    else if ((m = rest.match(/^:(focus-visible|focus-within|focus)(?![\w-])/))) {
      spec[1]++;
      const f = STATE.focused;
      if (m[1] === 'focus-within') { let a = f; while (a && a !== el) a = a.parent; if (!a) ok = false; }
      else if (el !== f) ok = false;
    }
    else if ((m = rest.match(/^:(first-child|last-child|nth-child\([^)]*\)|hover|active|checked|disabled)(?![\w-])/))) {
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

// Which element has keyboard focus while a value is computed (round 52).
const STATE = { focused: null };
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
const ENVS = [
  { name: '390px phone (README.md:109)', width: 390, height: 844, touch: true, motion: 'no-preference' },
  { name: '1440x900 screen at 200% zoom', width: 720, height: 450, touch: false, motion: 'no-preference' },
  { name: '1280x800 screen at 200% zoom', width: 640, height: 400, touch: false, motion: 'no-preference' },
];

// ---- The focus ring of tabindex="0" scrollers against a clipping parent ----
const px = v => {
  const m = String(v ?? '').trim().match(/^(-?\d*\.?\d+)(px|rem)?$/);
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
};
function sides(el, prop, env) {
  // A box shorthand (padding, margin) and its longhands; a longhand from a later or more specific rule wins
  // only if this harness found it, else the shorthand's value.
  const short = computed(el, prop, env);
  const w = short ? words(short).map(x => px(x) ?? 0) : [0];
  const base = { top: w[0], right: w[1] ?? w[0], bottom: w[2] ?? w[0], left: w[3] ?? w[1] ?? w[0] };
  for (const s of Object.keys(base)) {
    const v = computed(el, `${prop}-${s}`, env);
    if (v !== undefined && px(v) !== null) base[s] = px(v);
  }
  return base;
}
function ring(el, env) {
  const o = computed(el, 'outline', env);
  let style = computed(el, 'outline-style', env), width = computed(el, 'outline-width', env);
  if (o) {
    const ws = words(o);
    if (/^(none|0)$/.test(o.trim())) style = style ?? 'none';
    style = style ?? ws.find(x => /^(solid|dashed|dotted|double|groove|ridge|inset|outset|auto|none)$/.test(x));
    width = width ?? ws.find(x => px(x) !== null);
  }
  const offset = px(computed(el, 'outline-offset', env) ?? '0') ?? 0;
  return { style: style ?? 'none', width: px(width ?? '3px') ?? 3, offset };
}
const clips = (el, env) => /^(hidden|clip)/.test(computed(el, 'overflow-x', env) ?? computed(el, 'overflow', env) ?? '');
const elementChildren = el => el.children;

for (const env of ENVS) {
  test(`${env.name} (${env.width}px CSS): every tabindex="0" scroller's focus ring stays inside the box that clips it`, () => {
    const bad = [];
    let checked = 0, tabStops = 0;
    for (const file of walk(pagesDir)) {
      const els = elements(page(file));
      for (const el of els) {
        if (el.attrs.tabindex?.trim() !== '0' || /^(a|button|input|select|textarea|summary)$/.test(el.tag)) continue;
        tabStops++;
        const parent = el.parent;
        if (!parent || !clips(parent, env)) continue;
        STATE.focused = el;
        const r = ring(el, env);
        STATE.focused = null;
        if (r.style === 'none') { bad.push(`${relative(pagesDir, file)}: <${el.tag}> has no focus ring at all`); continue; }
        checked++;
        const ext = r.offset + r.width;
        const pad = sides(parent, 'padding', env);
        const mar = sides(el, 'margin', env);
        // Flush sides: a block child fills its parent's width, so left and right always; bottom when it is
        // the last element child, top when it is the first.
        const kids = elementChildren(parent);
        const flush = ['left', 'right'];
        if (kids.at(-1) === el) flush.push('bottom');
        if (kids[0] === el) flush.push('top');
        const cut = flush.filter(s => ext > pad[s] + mar[s] + 0.01);
        if (cut.length) {
          bad.push(`${relative(pagesDir, file)}: <${el.tag}${el.classes.size ? '.' + [...el.classes].join('.') : ''}> "${el.text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 50)}" ` +
            `ring ${r.width}px at offset ${r.offset}px reaches ${ext}px outside it, but its parent <${parent.tag}.${[...parent.classes].join('.')}> clips ` +
            `(overflow hidden) with padding ${JSON.stringify(pad)}: the ring's ${cut.join(', ')} side${cut.length > 1 ? 's are' : ' is'} cut away`);
        }
      }
    }
    // Control: the pages still ship tabindex="0" scrollers (the r50 boxes, the r51 code blocks and tables).
    assert.ok(tabStops > 0, 'control: some non-interactive element has tabindex="0"');
    assert.deepEqual(bad, [],
      `${bad.length} of the ${checked} tabindex="0" scrollers that sit in a clipping parent lose most of their ` +
      `focus ring when the keyboard focuses them, so focus is obscured (only a single edge, if any, is left):\n  ${bad.join('\n  ')}`);
  });
}
