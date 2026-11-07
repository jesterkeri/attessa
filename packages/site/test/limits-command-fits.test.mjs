// Adversary round 42 on the site (2be81cb1..3928c4f). Intended home: packages/site/test/limits-command-fits.test.mjs
// Run from the repo root: node --test packages/site/test/limits-command-fits.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// packages/site/README.md:109 to 110 says the site was "Checked in a desktop browser at 390, 768, 834, 1024, 1280, 1366
// and 1440px wide", and site.js:1 promises readable static HTML. On the home page, "Your agent can't
// overspend" (index.html:208 to 212) has a copyable command next to its two paragraphs:
//   <div class="cmd"><code>$ node /path/to/attessa/packages/mcp/dist/bin.js</code><button class="copy-btn">
// site.css:470 makes .cmd an inline-flex row that never wraps, and nothing lets its code break inside
// "/path/to/attessa/packages/mcp/dist/bin.js" (41 characters with no break opportunity; compare
// .try-steps code at site.css:508, which has overflow-wrap: anywhere). So the row is at least as wide as
// that path in mono plus the Copy button: about 398px.
// .limits-side (site.css:437) is a grid with one implicit auto column, so that column grows to the row's
// width and both paragraphs beside it are laid out that wide too. main clips overflow-x (site.css:80).
// Result, in every state (no JavaScript, CDN failed, and scene.js running), because none of these rules
// depend on no-js or scene-live:
//   390px phone: the column is 350px, the content runs to 418px. Line ends of "It signs a payment
//     permission, never a blank cheque ..." and "An MCP server with nine tools ..." are cut off, and the
//     Copy button sits at 358 to 419, half off screen.
//   768px tablet: the column is 289px, the content runs to 838px. The Copy button sits at 777 to 838,
//     entirely past the 768px edge but still in the tab order, so keyboard focus lands on a button no one
//     can see.
// Measured on the built page (node packages/site/build.mjs at 3928c4f), headless Chromium 1243 (playwright-core),
// 2026-11-05, every non-site request aborted (fallback fonts: DejaVu Sans Mono, 0.602em advance).
// Probe: probe42/offright.mjs and probe42/shot.mjs beside this file in the round's scratch folder.
//
// The test does not need a browser. It evaluates site.css's cascade (the round 38 to 41 harness) for the
// elements as the page ships them, takes the longest unbreakable run in the command, and computes the
// narrowest the row can be: run width in a 0.6em monospace (Geist Mono's advance, and a floor for common
// fallbacks) plus code padding and border, the row gap, and the Copy button's padding, border, gap and label
// (its Phosphor icon counted as 0px wide, so the bound is low). It compares that with the width the layout
// gives .limits-side at 390px and 768px, the two narrowest widths README.md:109 claims were checked.
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
    .replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, p) => readFileSync(join(src, 'partials', `${p}.html`), 'utf8'))
    // build.mjs:91 and :165: {{copyIcon}} is one Phosphor <i> element.
    .replace(/\{\{copyIcon\}\}/g, '<i class="ph ph-copy" aria-hidden="true"></i>');
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
        for (const d of inner.split(';')) {
          const k = d.indexOf(':');
          if (k < 0) continue;
          const prop = d.slice(0, k).trim().toLowerCase();
          let val = d.slice(k + 1).trim();
          const important = /!important\s*$/.test(val);
          val = val.replace(/!important\s*$/, '').trim();
          decls[prop] = { val, important };
        }
        // Shorthands this test reads as longhands.
        if (decls.overflow && !decls['overflow-x']) decls['overflow-x'] = { ...decls.overflow, val: decls.overflow.val.split(/\s+/)[0] };
        if (decls.gap && !decls['column-gap']) decls['column-gap'] = { ...decls.gap, val: splitTop(decls.gap.val, ' ').filter(Boolean).at(-1) };
        if (decls['word-wrap'] && !decls['overflow-wrap']) decls['overflow-wrap'] = decls['word-wrap'];
        if (decls['flex-flow'] && !decls['flex-wrap']) decls['flex-wrap'] = { ...decls['flex-flow'], val: /wrap/.test(decls['flex-flow'].val) ? decls['flex-flow'].val.match(/wrap(-reverse)?/)[0] : 'nowrap' };
        for (const sel of splitTop(prelude, ',')) out.push({ sel: sel.trim(), media, decls, order: order++ });
      }
      i = j;
    }
  };
  parse(s, []);
  return out;
}
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
const RELEVANT = /\.(cmd|copy-btn|limits-side|limits-head|limits-sec|wrap|scene-sticky)\b|(^|[\s>(])code\b|:root\s*$/;
function computed(el, prop, env) {
  let best = null;
  for (const r of RULES) {
    if (!(prop in r.decls) || !mediaMatches(r.media, env)) continue;
    const m = matchSelector(r.sel, el);
    if (m.unsupported) {
      if (RELEVANT.test(r.sel)) throw new Error(`selector not supported by this test: ${r.sel}`);
      continue;
    }
    if (!m.ok) continue;
    const key = [r.decls[prop].important ? 1 : 0, ...m.spec, r.order];
    if (!best || lexGreaterOrEqual(key, best.key)) best = { key, val: r.decls[prop].val };
  }
  return best?.val;
}
const INHERITED = new Set(['overflow-wrap', 'word-break', 'white-space', 'letter-spacing', 'font-size']);
function inherited(el, prop, env) {
  for (let a = el; a; a = a.parent) { const v = computed(a, prop, env); if (v !== undefined && v !== 'inherit') return v; }
  return undefined;
}
const get = (el, prop, env) => (INHERITED.has(prop) ? inherited(el, prop, env) : computed(el, prop, env));

// ---- Lengths ----
const ROOT_FS = 16;
function px(v, { em, env, vars = {} }) {
  v = v.trim().replace(/var\((--[\w-]+)\)/g, (_, n) => { if (!(n in vars)) throw new Error(`unknown ${n}`); return vars[n]; });
  let m;
  if ((m = v.match(/^max\((.*)\)$/))) return Math.max(...splitTop(m[1], ',').filter(p => !/env\(/.test(p)).map(p => px(p, { em, env, vars })));
  if ((m = v.match(/^clamp\((.*)\)$/))) { const [lo, mid, hi] = splitTop(m[1], ',').map(p => px(p, { em, env, vars })); return Math.min(hi, Math.max(lo, mid)); }
  if (v === '0') return 0;
  if ((m = v.match(/^(-?[\d.]+)(px|rem|em|vw)$/))) {
    const n = parseFloat(m[1]);
    return m[2] === 'px' ? n : m[2] === 'rem' ? n * ROOT_FS : m[2] === 'em' ? n * em : n * env.width / 100;
  }
  throw new Error(`length not supported by this test: ${v}`);
}
const fontSizeOf = font => font.match(/(?:^|\s)([\d.]+(?:px|rem|em))(?:\/[\d.]+)?(?:\s|$)/)?.[1];
const horiz = pad => { const p = pad.trim().split(/\s+/); return [p[1] ?? p[0], p[3] ?? p[1] ?? p[0]]; };

// The two narrowest widths README.md:109 says were checked, as a phone and a tablet (touch, overlay scrollbars).
const ENVS = [
  { width: 390, height: 844, touch: true },
  { width: 768, height: 1024, touch: true },
];
const STATES = {
  'without JavaScript': classes => classes.add('no-js'),
  'with JavaScript on but a CDN import failed': classes => classes.delete('no-js'),
  'with everything working': classes => { classes.delete('no-js'); classes.add('scene-live'); },
};
const MONO_ADVANCE = 0.6; // em per character: Geist Mono; DejaVu Sans Mono, the usual fallback, is 0.602

for (const env of ENVS) for (const [state, apply] of Object.entries(STATES)) {
  test(`index.html ${state}, ${env.width}px wide: the MCP command and its Copy button fit beside the spending limits instead of pushing the copy past the screen edge`, () => {
    const els = elements(page('index.html'));
    const html = els[0];
    assert.ok(html.tag === 'html' && html.classes.has('no-js'), 'layout ships <html class="no-js">');
    apply(html.classes);

    const side = els.find(e => e.classes.has('limits-side'));
    assert.ok(side, 'the home page has the spending limits copy (.limits-side)');
    const cmd = els.find(e => e.classes.has('cmd') && (() => { for (let a = e.parent; a; a = a.parent) if (a === side) return true; return false; })());
    assert.ok(cmd, '.limits-side holds a .cmd row');
    const code = els.find(e => e.tag === 'code' && e.parent === cmd);
    const btn = els.find(e => e.classes.has('copy-btn') && e.parent === cmd);
    assert.ok(code && btn, 'the .cmd row is a code element and a Copy button');
    const head = side.parent;
    assert.ok(head.classes.has('limits-head'), '.limits-side sits in .limits-head');
    const wrap = head.parent;
    assert.ok(wrap.classes.has('wrap'), '.limits-head sits in a .wrap');

    // Width the layout gives .limits-side.
    const vars = { '--gutter': computed(html, '--gutter', env) };
    const pad = computed(wrap, 'padding-left', env);
    const content = env.width - 2 * px(pad, { em: ROOT_FS, env, vars });
    const cols = splitTop(computed(head, 'grid-template-columns', env), ' ').filter(Boolean)
      .map(c => { const m = c.match(/^minmax\(0,\s*([\d.]+)fr\)$|^([\d.]+)fr$/); if (!m) throw new Error(`grid track not supported: ${c}`); return parseFloat(m[1] ?? m[2]); });
    const colGap = px(computed(head, 'column-gap', env) ?? '0', { em: ROOT_FS, env, vars });
    const kids = els.filter(e => e.parent === head);
    const col = cols.length === 1 ? 0 : kids.indexOf(side) % cols.length;
    const track = (content - colGap * (cols.length - 1)) * cols[col] / cols.reduce((a, b) => a + b, 0);
    const maxW = computed(side, 'max-width', env);
    const available = Math.min(track, maxW && maxW !== 'none' ? px(maxW, { em: ROOT_FS, env, vars }) : Infinity);

    // A row that scrolls loses nothing; then there is nothing to prove.
    if (/^(auto|scroll)$/.test(computed(cmd, 'overflow-x', env) ?? '')) return;

    // Narrowest the code can be: its longest unbreakable run in mono, plus its padding and border.
    const cmdFs = px(fontSizeOf(computed(cmd, 'font', env) ?? '') ?? `${ROOT_FS}px`, { em: ROOT_FS, env, vars });
    const codeFsRaw = computed(code, 'font-size', env);
    const codeFs = codeFsRaw ? px(codeFsRaw, { em: cmdFs, env, vars }) : cmdFs;
    const breaksAnywhere = get(code, 'overflow-wrap', env) === 'anywhere' || /break-all/.test(get(code, 'word-break', env) ?? '');
    const nowrap = /^(nowrap|pre)$/.test(get(code, 'white-space', env) ?? '');
    const text = code.text.replace(/&nbsp;/g, ' ').trim();
    const longest = breaksAnywhere ? 1 : Math.max(...(nowrap ? [text] : text.split(/\s+/)).map(w => [...w].length));
    assert.equal(text.split(/\s+/).at(-1), '/path/to/attessa/packages/mcp/dist/bin.js', 'control: the command ends in the 41-character path');
    const [cpl, cpr] = horiz(computed(code, 'padding', env) ?? '0').map(p => px(p, { em: codeFs, env, vars }));
    const codeBorder = /^(\d+(?:\.\d+)?)px/.exec(computed(code, 'border', env) ?? '')?.[1] ?? 0;
    const codeMin = longest * MONO_ADVANCE * codeFs + cpl + cpr + 2 * Number(codeBorder);

    // Narrowest the Copy button can be: padding, border, the label in mono with its letter spacing, and the
    // gap between icon and label. The icon itself counts as 0px.
    const btnFs = px(fontSizeOf(computed(btn, 'font', env) ?? '') ?? '16px', { em: cmdFs, env, vars });
    const [bpl, bpr] = horiz(computed(btn, 'padding', env) ?? '0').map(p => px(p, { em: btnFs, env, vars }));
    const btnBorder = /^(\d+(?:\.\d+)?)px/.exec(computed(btn, 'border', env) ?? '')?.[1] ?? 0;
    const ls = px(get(btn, 'letter-spacing', env) ?? '0', { em: btnFs, env, vars });
    const label = els.find(e => e.parent === btn && 'data-copy-label' in e.attrs).text.trim();
    const btnGap = px(computed(btn, 'column-gap', env) ?? '0', { em: btnFs, env, vars });
    const btnMin = bpl + bpr + 2 * Number(btnBorder) + [...label].length * (MONO_ADVANCE * btnFs + ls) + btnGap;

    const rowGap = px(computed(cmd, 'column-gap', env) ?? '0', { em: cmdFs, env, vars });
    const wraps = /^wrap/.test(computed(cmd, 'flex-wrap', env) ?? 'nowrap');
    const rowMin = wraps ? Math.max(codeMin, btnMin) : codeMin + rowGap + btnMin;

    assert.ok(rowMin <= available + 0.5,
      `the command row ("${text}" and its Copy button) is at least ${rowMin.toFixed(0)}px wide ` +
      `(code ${codeMin.toFixed(0)}px for its ${longest}-character unbreakable path, gap ${rowGap}px, button ${btnMin.toFixed(0)}px), ` +
      `but .limits-side gets ${available.toFixed(0)}px at ${env.width}px; its implicit grid column grows to the row, ` +
      `so the paragraphs beside it are laid out that wide too, and main (overflow-x: clip) cuts off their line ends and the Copy button`);
  });
}
