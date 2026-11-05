// Adversary round 48 on the site (2be81cb..1ba77a9). Intended home: site/test/menu-fits-at-200-zoom.test.mjs
// Run from the repo root: node --test site/test/menu-fits-at-200-zoom.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// site/README.md:109 says the site was "Checked in a desktop browser at 390, 768, 834, 1024, 1280, 1366 and
// 1440px wide", and README.md:104 says "The nav collapses to a menu under 1020px". Earlier rounds already hold
// the menu to browser zoom up to 200% (menu-close-keeps-focus.test.mjs:6, menu-breakpoint-no-gap.test.mjs:26):
// at 200% zoom a 1280x800, 1366x768 or 1440x900 screen lays the page out at 640x400, 683x384 or 720x450 CSS
// px, so the phone menu is what a keyboard or low-vision user on those desktops navigates with (WCAG 2.2
// SC 1.4.4 Resize Text and SC 2.4.11 Focus Not Obscured, both AA).
//
// The menu can't fit there, and nothing lets the user reach what doesn't fit:
//   - site.css:154 makes .menu `position: fixed; inset: 0; display: flex; flex-direction: column;
//     justify-content: center; gap: 36px; padding: 100px 28px 40px` with no overflow-y, so it never scrolls,
//     and the page under it doesn't move it.
//   - site.css:156 sets each of its five links to clamp(2.3rem, 10vw, 3.2rem) = 51.2px with line-height 1,
//     14px and 12px padding and a 1px rule: 78.2px each. With the nav's 1px top rule, the 36px gap and the
//     50px "Explorer preview" button (site.css:92), the column is 478px even if every link fits one line.
//   - justify-content: center splits the overflow between both ends, so the first link is pushed up under the
//     fixed nav bar (68px, site.css:37 and :115, z-index 40 over the menu's 35) and the button down past the
//     bottom of the screen.
// At 683x384 the first link, "How it works", sits at -16 to 62px (its text -2 to 49px), wholly behind the nav
// bar (the wordmark and close button over it, 80% opaque once the page has scrolled, site.css:116-117), and the button at
// 411 to 461px, wholly below the 384px screen. site.js:44 puts focus on that first link as the menu opens, so
// focus starts on something the user can't see, and Tab later moves it to the button they can't see either.
//
// Measured on the built page (adv-site-r48 worktree at 1ba77a9, dist as built), headless Chromium 1243
// (playwright-core), 2026-11-05, JavaScript on with every third-party request aborted, menu opened by clicking
// the menu button (probe/menufit.mjs beside this file; screenshot probe/menu-cdnfail-640x400.png). The fallback
// face wraps "Security and limits" to two lines there, which makes it worse:
//   640x400: How it works top -34 bottom 45; Security and limits 279 to 409; Explorer preview 445 to 495
//   683x384: How it works top -42 bottom 37; Explorer preview 437 to 487
//   720x450: How it works top 17 bottom 95; Explorer preview 444 to 494
//   768x432 (a 1536x864 window, 1920x1080 at 125% scaling, at 200% zoom): Explorer preview 435 to 487
// A scrolling flex column with plain `justify-content: center` still can't reach what overflows at its start
// (probe/flexcenter.mjs: first item at -20px before and after scrollTop = -1000), so overflow-y: auto alone
// would leave the first link under the nav bar.
//
// The test does not need a browser. It evaluates site.css's cascade (the round 38 to 47 harness) for the open
// menu as layout.html ships it, at the README's three desktop widths at 200% zoom, using the full screen height
// (a real window is shorter by the browser's own toolbars, so this is the generous case), and lays out the
// menu's flex column assuming every link fits on one line (the narrowest any font can make it). Every item must
// land between the bottom of the nav bar and the bottom of the screen, after any scrolling the menu allows.
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
  if (parts.some(p => /^[+~]$/.test(p.compound))) return { unsupported: true };
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
// A selector this harness can't read is fatal only if its subject could be one of the elements measured here:
// the menu, its nav, its links and button, the nav bar, or the root.
const RELEVANT = /(^|[\s>])((a|nav|div|html|header|\*)(?=$|[.:[#])|[.:[#]|$)|\b(menu|btn|btn-primary|nav|nav-wrap)\b|:root/;
const relevantSubject = sel => { const subj = parseSelector(sel).at(-1).compound; return /^(a|nav|div|html|header|\*)?([.:[#]|$)/.test(subj) && (/\.(menu|btn|btn-primary|nav|nav-wrap)\b|:root|^(a|nav|html|\*)\b|^[:[]/.test(subj)); };
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

// ---- The open menu, laid out as a flex column ----
// The README's desktop widths (README.md:109) at 200% browser zoom, full screen height (the generous case).
const ENVS = [
  { name: '1366x768 screen at 200% zoom', width: 683, height: 384 },
  { name: '1280x800 screen at 200% zoom', width: 640, height: 400 },
  { name: '1440x900 screen at 200% zoom', width: 720, height: 450 },
];
// The menu opens only with JavaScript (site.css:681 hides its button without it).
const STATES = {
  'with JavaScript on but a CDN import failed': classes => classes.delete('no-js'),
  'with everything working': classes => { classes.delete('no-js'); classes.add('scene-live'); },
};

for (const base of ENVS) for (const [state, apply] of Object.entries(STATES)) {
  const env = { ...base, touch: false, motion: 'no-preference' };
  test(`phone menu, ${env.name} (${env.width}x${env.height} CSS px), ${state}: every menu item can be brought into view below the nav bar`, () => {
    const els = elements(page('index.html'));
    const html = els[0];
    assert.ok(html.tag === 'html' && html.classes.has('no-js'), 'layout ships <html class="no-js">');
    apply(html.classes);
    html.classes.add('menu-open'); // site.js:41

    const menu = els.find(e => e.attrs.id === 'menu');
    assert.ok(menu, 'layout has #menu');
    delete menu.attrs.hidden; // site.js:40 opens it
    const vars = { '--nav-h': computed(html, '--nav-h', env) };
    const L = (el, prop, fallback = '0') => px(get(el, prop, env) ?? fallback, { em: px(get(el, 'font-size', env) ?? `${ROOT_FS}px`, { em: ROOT_FS, env, vars }), env, vars });

    // Controls: the menu shows at this width and covers the screen as a fixed flex column under the nav bar.
    const btn = els.find(e => e.classes.has('menu-btn'));
    assert.equal(computed(btn, 'display', env), 'inline-grid', `control: the menu button shows at ${env.width}px`);
    assert.equal(computed(menu, 'position', env), 'fixed', 'control: the menu is fixed');
    assert.equal(computed(menu, 'inset', env), '0', 'control: the menu covers the viewport');
    assert.equal(computed(menu, 'display', env), 'flex', 'control: the menu is a flex box');
    assert.equal(computed(menu, 'flex-direction', env), 'column', 'control: the menu is a column');
    const navWrap = els.find(e => e.classes.has('nav-wrap'));
    const navBar = els.find(e => e.tag === 'header' && e.classes.has('nav'));
    assert.equal(computed(navWrap, 'position', env), 'fixed', 'control: the nav bar is fixed');
    assert.ok(Number(computed(navWrap, 'z-index', env)) > Number(computed(menu, 'z-index', env)), 'control: the nav bar sits over the menu');
    const navBottom = px(computed(navBar, 'height', env), { em: ROOT_FS, env, vars });

    // The menu's two flex items: the link list and the button.
    const kids = menu.children;
    assert.deepEqual(kids.map(k => k.tag + (k.classes.has('btn') ? '.btn' : '')), ['nav', 'a.btn'], 'control: menu holds its nav and one button');
    const [list, cta] = kids;
    const links = list.children.filter(e => e.tag === 'a');
    assert.equal(links.length, 5, 'control: five links in the menu');

    // Heights, each link on one line (the best case for any font).
    const items = [];
    let y = L(list, 'border-top-width');
    for (const a of links) {
      const fs = L(a, 'font-size', `${ROOT_FS}px`);
      const lhRaw = get(a, 'line-height', env);
      assert.ok(lhRaw && lhRaw !== 'normal', `control: the menu link sets a line-height (got ${lhRaw})`);
      const lh = /^[\d.]+$/.test(lhRaw) ? Number(lhRaw) * fs : L(a, 'line-height');
      const h = lh + L(a, 'padding-top') + L(a, 'padding-bottom') + L(a, 'border-top-width') + L(a, 'border-bottom-width');
      // Its text: inside the border and padding.
      items.push({ name: a.text.trim(), top: y, bottom: y + h, textTop: y + L(a, 'border-top-width') + L(a, 'padding-top'), textBottom: y + h - L(a, 'border-bottom-width') - L(a, 'padding-bottom') });
      y += h;
    }
    const listH = y + L(list, 'border-bottom-width');
    const gap = L(menu, 'row-gap');
    const ctaFs = L(cta, 'font-size', `${ROOT_FS}px`);
    const ctaLhRaw = get(cta, 'line-height', env) ?? 'normal';
    const ctaLh = /^[\d.]+$/.test(ctaLhRaw) ? Number(ctaLhRaw) * ctaFs : ctaLhRaw === 'normal' ? 1.2 * ctaFs : L(cta, 'line-height');
    const ctaH = Math.max(L(cta, 'min-height'), ctaLh + L(cta, 'padding-top') + L(cta, 'padding-bottom') + L(cta, 'border-top-width') + L(cta, 'border-bottom-width'));
    const content = listH + gap + ctaH;
    items.push({ name: cta.text.replace(/\{\{\w+\}\}/g, '').trim(), top: listH + gap, bottom: listH + gap + ctaH, textTop: listH + gap, textBottom: listH + gap + ctaH });

    // Main-axis placement (CSS Box Alignment): plain center splits overflow between both ends; safe center and
    // start never push content above the start edge.
    const padTop = L(menu, 'padding-top'), padBottom = L(menu, 'padding-bottom');
    const free = env.height - padTop - padBottom - content;
    const jc = (computed(menu, 'justify-content', env) ?? 'normal').trim();
    let start;
    if (/^(normal|flex-start|start|safe (flex-)?start)$/.test(jc)) start = padTop;
    else if (jc === 'center' || jc === 'unsafe center') start = padTop + free / 2;
    else if (jc === 'safe center') start = padTop + Math.max(0, free / 2);
    else if (/^(unsafe )?(flex-end|end)$/.test(jc)) start = padTop + free;
    else if (/^safe (flex-end|end)$/.test(jc)) start = padTop + Math.max(0, free);
    else throw new Error(`justify-content not supported by this test: ${jc}`);
    const scrolls = /^(auto|scroll)$/.test(computed(menu, 'overflow-y', env) ?? 'visible');

    const problems = [];
    for (const it of items) {
      const top = start + it.textTop, bottom = start + it.textBottom;
      // Scrolling the menu (if it can) moves items up, never down, so an item's text (a link's, inside its
      // padding; the button's whole box) must clear the nav bar as laid out, and must fit the screen unless the
      // menu can scroll it up into view.
      if (top < navBottom - 0.5) problems.push(`"${it.name}" (text ${top.toFixed(0)} to ${bottom.toFixed(0)}px) ${bottom <= navBottom ? 'is wholly' : 'starts'} behind the ${navBottom}px nav bar${top < 0 ? ' and above the screen' : ''}`);
      else if (bottom > env.height + 0.5 && !scrolls) problems.push(`"${it.name}" (${top.toFixed(0)} to ${bottom.toFixed(0)}px) ${top >= env.height ? 'is wholly below' : 'runs past'} the ${env.height}px screen, and the menu can't scroll`);
    }
    assert.deepEqual(problems, [],
      `the open menu's column is ${content.toFixed(1)}px (padding ${padTop}px and ${padBottom}px) in a ${env.height}px screen, ` +
      `justify-content: ${jc}, overflow-y: ${scrolls ? 'scrolls' : 'does not scroll'}: ${problems.join('; ')}. ` +
      `site.js:44 focuses the first link as the menu opens, and Tab reaches items the user can't see`);
  });
}
