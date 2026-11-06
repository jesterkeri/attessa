// Adversary round 53 on the site (2be81cb..430fb10). Intended home: packages/site/test/docs-nav-focus-ring-visible.test.mjs
// Run from the repo root: node --test packages/site/test/docs-nav-focus-ring-visible.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// Round 52 found that a focused docs code block lost its focus ring to its clipping figure, and the fix
// (a011230, site.css:934) drew that one ring inside. The same cut happens to every link in the docs menu on a
// desktop or laptop screen, on all five docs pages, and nothing has fixed it.
//
// Over 860px the docs menu is a sticky column that scrolls on its own: site.css:897 `.docs-nav { position:
// sticky; ... max-height: calc(100svh - var(--nav-h) - 64px); overflow-y: auto; ... }`. overflow-y: auto
// makes overflow-x auto too, so the aside clips on all four sides, and it has no padding. Each link is
// site.css:904 `.docs-nav a { display: block; padding: 6px 0 6px 14px; border-left: 1px solid ... }`, so it
// spans the aside edge to edge (ul and li are reset to margin 0, padding 0, site.css:46). A focused link
// takes the site-wide ring, site.css:52 `:focus-visible { outline: 1.5px solid var(--text); outline-offset:
// 3px; }`, drawn 3 to 4.5px outside the link: its left and right sides fall outside the aside and are cut
// away. What is left is two horizontal lines. On the menu's last link, "Known limits", the bottom side is cut
// too (the link is the aside's last box), so the only sign of focus is one line between "Threat model" and
// "Known limits", which reads as a divider and does not say which of the two has focus. The link's own text
// colour does not change on focus.
//
// Measured on the built pages (adv-site-r53 worktree at 430fb10, dist as built), headless Chromium
// (playwright-core, chrome-headless-shell 1243), 2026-11-05, every non-site request aborted, JS on with the
// CDN imports failing; probe/navring.mjs and probe/ringwalk.mjs beside this file (Tab from the top of the
// page; for each focused docs-menu link, screenshot of the link plus 8px with the ring and with
// outline-style none, changed pixels per side):
//   1440x900, docs/reference.html: docs-nav overflow auto/auto, padding 0; every one of the 15 links:
//     "solid 1px rgb(237, 237, 238) off 3px", :focus-visible true, changed px top 220, right 0, bottom 220,
//     left 0. "Known limits" (rect [120,865.4,340,896.8], aside clip [120,149,340,897]): top 220, right 0,
//     bottom 0, left 0.
//   ringwalk.mjs found the same 15 links cut left and right on all five docs pages at 1440x900, and nothing
//   else in the docs pages or the other seven pages cut by a clipping ancestor (390x844, 720x450, 1440x900).
//
// The test needs no browser. It evaluates site.css's cascade (round 52's harness, copied, with build.mjs's
// {{doc:}}, {{cur:}} and {{root}} expansions) for each docs-menu link in its :focus-visible state at the
// README's desktop widths (packages/site/README.md:110, "1024, 1280, 1366 and 1440px"), finds the nearest ancestor
// that clips (any overflow other than visible), and asks whether the ring stays inside it on each side the
// link sits flush against: outline-offset + outline-width must not exceed the margins, borders and padding
// between the link and that ancestor's padding box. Any fix passes: an inset ring for these links, room
// round them, or a menu that doesn't clip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(src, 'static', 'assets', 'site.css'), 'utf8');
const layout = readFileSync(join(src, 'layout.html'), 'utf8');
const expand = (html, depth = 0) => depth > 3 ? html
  : html.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, p) => expand(readFileSync(join(src, 'partials', `${p}.html`), 'utf8'), depth + 1));
// build.mjs's page assembly, for the shorthands that change markup this test reads; the rest become empty.
const page = file => {
  const raw = readFileSync(file, 'utf8');
  const meta = Object.fromEntries([...raw.matchAll(/^<!--\s*(\w+):\s*(.*?)\s*-->\s*$/gm)].map(m => [m[1], m[2]]));
  const body = raw.replace(/^<!--\s*\w+:.*?-->\s*\r?\n/gm, '');
  return layout.replace('{{content}}', () => expand(body))
    .replace(/\{\{cur:(\w+)\}\}/g, (_, k) => (k === meta.nav ? ' aria-current="page"' : ''))
    .replace(/\{\{doc:(\w+)\}\}/g, (_, k) => (k === meta.doc ? ' aria-current="page"' : ''))
    .replace(/\{\{bodyClass\}\}/g, () => meta.body ?? '')
    .replace(/\{\{root\}\}/g, '')
    .replace(/\{\{[^}]*\}\}|\[\[[^\]]*\]\]/g, '');
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
        // The overflow shorthand as its two longhands (a longhand in the same rule wins).
        if (decls.overflow) { const o = words(decls.overflow.val); set('overflow-x', decls.overflow, o[0]); set('overflow-y', decls.overflow, o[1] ?? o[0]); }
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

// ---- Selectors: compounds joined by descendant, child or sibling combinators ----
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
    // The keyboard-focused element (STATE.focused) matches :focus and :focus-visible; its ancestors match
    // :focus-within. Every other state pseudo-class is off.
    else if ((m = rest.match(/^:(focus-visible|focus-within|focus)(?![\w-])/))) {
      spec[1]++;
      const f = STATE.focused;
      if (m[1] === 'focus-within') { let a = f; while (a && a !== el) a = a.parent; if (!a) ok = false; }
      else if (el !== f) ok = false;
    }
    else if ((m = rest.match(/^:(first-child|last-child|nth-child\([^)]*\)|hover|active|checked|disabled)(?![\w-])/))) {
      spec[1]++;
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

const STATE = { focused: null };
const RULES = rules(css);
const lexGreaterOrEqual = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };
// The elements between a docs-menu link and the aside, and the aside itself.
const CHAIN_TAGS = new Set(['a', 'li', 'ul', 'div', 'details', 'aside', 'nav']);
// A selector this harness can't read is fatal only if its subject could be one of those elements.
const relevantSubject = sel => {
  const subj = parseSelector(sel).at(-1).compound;
  if (/::/.test(subj)) return false;
  const tag = subj.match(/^([a-zA-Z][\w-]*)/)?.[1];
  return !tag || CHAIN_TAGS.has(tag);
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
const ENVS = [
  { name: '1024x768 (README.md:110)', width: 1024, height: 768, touch: false, motion: 'no-preference' },
  { name: '1280x800 (README.md:110)', width: 1280, height: 800, touch: false, motion: 'no-preference' },
  { name: '1366x768 (README.md:110)', width: 1366, height: 768, touch: false, motion: 'no-preference' },
  { name: '1440x900 (README.md:110)', width: 1440, height: 900, touch: false, motion: 'no-preference' },
];

// ---- The focus ring of a docs-menu link against the box that clips it ----
const px = v => {
  const m = String(v ?? '').trim().match(/^(-?\d*\.?\d+)(px|rem)?$/);
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
};
const SIDES = ['top', 'right', 'bottom', 'left'];
function sides(el, prop, env) {
  // A box shorthand (padding, margin) and its longhands; the longhand wins where this harness found one.
  const short = computed(el, prop, env);
  const w = short ? words(short).map(x => px(x) ?? 0) : [0];
  const base = { top: w[0], right: w[1] ?? w[0], bottom: w[2] ?? w[0], left: w[3] ?? w[1] ?? w[0] };
  for (const s of SIDES) {
    const v = computed(el, `${prop}-${s}`, env);
    if (v !== undefined && px(v) !== null) base[s] = px(v);
  }
  return base;
}
function borders(el, env) {
  // Border widths from `border`, `border-<side>` and `border-block` / `border-inline` (a width in px, else 0).
  const width = v => { if (!v || /^(none|0)$/.test(v.trim())) return 0; const w = words(v).map(px).find(x => x !== null); return w ?? 1; };
  const all = width(computed(el, 'border', env));
  const out = { top: all, right: all, bottom: all, left: all };
  const block = computed(el, 'border-block', env), inline = computed(el, 'border-inline', env);
  if (block !== undefined) out.top = out.bottom = width(block);
  if (inline !== undefined) out.left = out.right = width(inline);
  for (const s of SIDES) { const v = computed(el, `border-${s}`, env); if (v !== undefined) out[s] = width(v); }
  return out;
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
  const shadow = computed(el, 'box-shadow', env);
  return { style: style ?? 'none', width: px(width ?? '3px') ?? 3, offset, insetShadow: !!shadow && /\binset\b/.test(shadow) };
}
const clips = (el, env) => {
  const x = computed(el, 'overflow-x', env) ?? 'visible', y = computed(el, 'overflow-y', env) ?? 'visible';
  return x !== 'visible' || y !== 'visible';
};
const desc = el => `<${el.tag}${el.classes.size ? '.' + [...el.classes].join('.') : ''}>`;
const text = el => el.text.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 40);

const docsPages = walk(pagesDir).filter(f => /[\\/]docs[\\/]/.test(f));
for (const env of ENVS) {
  test(`${env.name}: a keyboard-focused docs-menu link keeps its whole focus ring inside the menu that clips it`, () => {
    const bad = [];
    let links = 0, clipped = 0;
    for (const file of docsPages) {
      const els = elements(page(file));
      const aside = els.find(e => e.classes.has('docs-nav'));
      assert.ok(aside, `control: ${relative(pagesDir, file)} has the docs menu`);
      const navLinks = els.filter(e => e.tag === 'a' && 'href' in e.attrs && (() => { for (let p = e.parent; p; p = p.parent) if (p === aside) return true; return false; })());
      for (const a of navLinks) {
        links++;
        // The nearest ancestor that clips, and the elements between it and the link.
        const chain = [];
        let clipper = null;
        for (let p = a.parent; p; p = p.parent) { if (clips(p, env)) { clipper = p; break; } chain.push(p); }
        if (!clipper) continue;
        clipped++;
        STATE.focused = a;
        const r = ring(a, env);
        STATE.focused = null;
        if (r.style === 'none') { if (!r.insetShadow) bad.push(`${relative(pagesDir, file)}: "${text(a)}" has no focus ring at all`); continue; }
        const ext = r.offset + r.width;
        // Room between the link's border box and the clipper's padding box, per side.
        const room = sides(a, 'margin', env);
        for (const p of chain) {
          const m = sides(p, 'margin', env), pd = sides(p, 'padding', env), b = borders(p, env);
          for (const s of SIDES) room[s] += m[s] + pd[s] + b[s];
        }
        const cp = sides(clipper, 'padding', env);
        for (const s of SIDES) room[s] += cp[s];
        // Flush sides: a block link fills the menu's width, so left and right; bottom when it and every box
        // above it up to the clipper is its parent's last element child, top likewise for the first.
        const isBlock = /^(block|flex|grid)$/.test(computed(a, 'display', env) ?? 'inline');
        const flush = isBlock ? ['left', 'right'] : [];
        const line = [a, ...chain];
        if (line.every(e => e.parent.children.at(-1) === e)) flush.push('bottom');
        if (line.every(e => e.parent.children[0] === e)) flush.push('top');
        const cut = flush.filter(s => ext > room[s] + 0.01);
        if (cut.length) bad.push(`${relative(pagesDir, file)}: "${text(a)}" ring ${r.width}px at offset ${r.offset}px reaches ${ext}px outside the link; ${desc(clipper)} clips (overflow ${computed(clipper, 'overflow-x', env) ?? 'visible'}/${computed(clipper, 'overflow-y', env) ?? 'visible'}) with ${JSON.stringify(room)} of room, so the ring's ${cut.join(', ')} side${cut.length > 1 ? 's are' : ' is'} cut away`);
      }
    }
    // Control: the docs pages still have their menu links.
    assert.ok(links >= 5 * 15, `control: expected the 15 docs-menu links on each of 5 docs pages, found ${links}`);
    assert.deepEqual(bad, [],
      `${bad.length} of the ${clipped} docs-menu links that sit in a clipping box lose part of their focus ring ` +
      `when the keyboard focuses them, so focus is obscured:\n  ${bad.join('\n  ')}`);
  });
}
