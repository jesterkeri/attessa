// Converted when T21 was merged (it was use-cases-cli-not-built.test.mjs, written while TASKS.md T21 was unticked).
// The rule stays: the site must agree with TASKS.md and the code. T21 is ticked and packages/cli has the buyer commands, so:
//   - use-cases tells buyers how to install the CLI (from source, D2) and offers `attessa call` as built;
//   - every `attessa ...` command any page shows is a real command in packages/cli/src/index.ts, unless that page marks it
//     Coming / not built (T21a `attessa verify`, `attessa release verify`, `attessa call --via buy` are not built).
// (TASKS.md is read from SITE_SRC/../../../TASKS.md or TASKS_MD; the CLI from SITE_SRC/../../cli/src/index.ts or CLI_INDEX.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const tasks = readFileSync(process.env.TASKS_MD ?? join(src, '..', '..', '..', 'TASKS.md'), 'utf8');
const cliIndex = readFileSync(process.env.CLI_INDEX ?? join(src, '..', '..', 'cli', 'src', 'index.ts'), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const walk = d => readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const marked = /\b(coming|planned|not built|isn't built|aren't built|not yet built|not available yet|once (it's )?live|when live|optional)\b/i;

// The commands index.ts dispatches: the keys of its COMMANDS table, plus `gateway` (handled before the table).
const block = cliIndex.slice(cliIndex.indexOf('const COMMANDS'), cliIndex.indexOf('\n};', cliIndex.indexOf('const COMMANDS')));
const real = new Set([...block.matchAll(/^\s{2}(?:'([a-z -]+)'|([a-z]+)):\s*\{/gm)].map(m => m[1] ?? m[2]));
real.add('gateway');
const isReal = words => {
  const [a, b] = words;
  return real.has(a) || real.has(`${a} ${b}`);
};

test('T21 is ticked and the CLI has the buyer commands (precondition)', () => {
  assert.match(tasks, /^- \[x\] T21 CLI per SPEC §8/m, 'TASKS.md T21 is not ticked: the site must go back to marking the buyer CLI Coming');
  for (const c of ['init', 'call', 'cancel', 'status', 'evidence export']) assert.ok(real.has(c), `packages/cli no longer has ${c}`);
  assert.ok(!real.has('verify'), 'attessa verify (T21a) is in the CLI now: stop marking it Coming on the site');
});

test('use-cases offers the CLI as built and says how to install it from source', () => {
  const t = text(readFileSync(join(src, 'pages', 'use-cases.html'), 'utf8'));
  const offers = t.split(/(?<=[.:])\s+/).filter(s => /\bCLI\b/.test(s));
  assert.ok(offers.length > 0, 'use-cases no longer mentions the CLI');
  assert.deepEqual(offers.filter(s => marked.test(s)), [], 'use-cases marks the built CLI as not built');
  assert.match(t, /attessa call/);
  const raw = readFileSync(join(src, 'pages', 'use-cases.html'), 'utf8');
  assert.match(raw, /href="docs\/tutorial\.html#install"/, 'use-cases does not link to the install steps');
  const tut = readFileSync(join(src, 'pages', 'docs', 'tutorial.html'), 'utf8');
  assert.ok(tut.includes('id="install"'), 'the install anchor moved');
  const steps = text(tut.slice(tut.indexOf('id="install"'), tut.indexOf('id="init"')));
  for (const s of ['git clone https://github.com/jesterkeri/attessa', 'pnpm install --frozen-lockfile && pnpm -r build', 'pnpm link --global']) assert.ok(steps.includes(s), `install steps lost: ${s}`);
  assert.doesNotMatch(steps, /npm i(nstall)? -g|npx /);
});

test('every attessa command a page shows is a real CLI command, or the page marks it not built', () => {
  const bad = [];
  for (const f of walk(src).filter(f => f.endsWith('.html'))) {
    const raw = readFileSync(f, 'utf8');
    for (const m of raw.matchAll(/<code>(?:<[^>]*>)*\s*attessa ([a-z][a-z -]*)/g)) {
      const words = m[1].trim().split(/\s+/);
      if (isReal(words)) continue;
      // The same block element (a table row, a paragraph or a list item) must mark it not built.
      const at = m.index;
      const around = raw.slice(Math.max(raw.lastIndexOf('<tr', at), raw.lastIndexOf('<p', at), raw.lastIndexOf('<li', at), raw.lastIndexOf('<a ', at)), raw.indexOf('</', at + 200));
      if (!marked.test(text(around))) bad.push(`${f.slice(src.length + 1)}: attessa ${words.join(' ')}`);
    }
  }
  assert.deepEqual(bad, [], 'commands shown as usable but not in packages/cli/src/index.ts');
});

import { SPECS, COMMANDS, GATEWAY_SUBCOMMANDS } from './lib/cli-table.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Codex site-finish r5 and r6. The page-wide checker reads what the BUILT site renders (partials expanded, meta descriptions and the
// site's own JS strings included), finds every `attessa ...` in the rendered text, and checks all of it against the CLI's real table:
//   - the command (one or two words) must be a key of COMMANDS in packages/cli/src/index.ts, or `gateway <sub>`;
//   - every option must exist for that command, spelled exactly; a string option takes the next token as its value;
//   - the positionals left over must not exceed that command's `args` count (parseArgs strict, then "Unexpected argument");
//   - the only exemption is one of three exact unbuilt shapes (UNBUILT), and only when its own block says Coming / not built.
// The text after `attessa` stops at the end of its element, or at sentence punctuation / "and" / "or" / "then" in running prose.
const UNBUILT = [/^verify(?: <\w+>)?$/, /^release verify(?: <\w+>)?$/, /^call --via buy(?: \S+)?$/];
// Running prose that starts with the word "attessa" and is not a command (the product name in a sentence).
const PROSE = [/^can't check\b/, /^checks which\b/, /^on your PATH\b/];
const BLOCKS = ['tr', 'li', 'p', 'h2', 'h3', 'figure', 'a'];
const enclosing = (raw, at) => {
  const open = BLOCKS.flatMap(tag => {
    const starts = [...raw.slice(0, at).matchAll(new RegExp(`<${tag}[\\s>]`, 'g'))];
    const start = starts.length ? starts[starts.length - 1].index : -1;
    return start > raw.lastIndexOf(`</${tag}>`, at) ? [{ tag, start }] : [];
  }).sort((x, y) => y.start - x.start)[0];
  return open ? raw.slice(open.start, raw.indexOf(`</${open.tag}>`, at)) : '';
};
// Character references, decoded once, the way a browser does (HTML Living Standard "character reference state"): decimal and hex
// numeric forms with or without the semicolon, named references (the legacy ones also without it), nothing else. A reference that
// does not match is left as literal text, and the decoded character is never decoded again (`&amp;#32;` shows as the text "&#32;").
// No HTML-decoder package is in the lockfile, so the table below is partial. A browser knows names it lacks (`&NonBreakingSpace;` shows a
// space), so a `&name;` not in the table is itself a violation: the scanner fails closed rather than read it as literal text.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', Tab: '\t', NewLine: '\n', ensp: ' ', emsp: ' ',
  emsp13: ' ', emsp14: ' ', numsp: ' ', puncsp: ' ', thinsp: ' ', ThinSpace: ' ', hairsp: ' ', VeryThinSpace: ' ',
  MediumSpace: ' ', ZeroWidthSpace: '​', NoBreak: '⁠', shy: '­', copy: '©', reg: '®', hellip: '…', mdash: '—',
  ndash: '–', middot: '·', rarr: '→', larr: '←', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×',
  lpar: '(', rpar: ')', lbrack: '[', rbrack: ']', lsqb: '[', rsqb: ']', lbrace: '{', rbrace: '}', lcub: '{', rcub: '}', comma: ',', period: '.',
  colon: ':', semi: ';', excl: '!', quest: '?', num: '#', percnt: '%', dollar: '$', ast: '*', plus: '+', equals: '=', sol: '/', bsol: '\\',
  lowbar: '_', grave: '`', hyphen: '-', dash: '-', verbar: '|', vert: '|', commat: '@', Hat: '^', tilde: '˜' };
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'shy', 'copy', 'reg', 'times']); // decoded even without the semicolon
const CP1252 = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2c6, 0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039,
  0x8c: 0x152, 0x8e: 0x17d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x2dc, 0x99: 0x2122,
  0x9a: 0x161, 0x9b: 0x203a, 0x9c: 0x153, 0x9e: 0x17e, 0x9f: 0x178 };
const REF = /^&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*))(;?)/;
/** The reference starting at s[0] === '&': { ch, len } or null (literal). */
const decodeRef = s => {
  const m = REF.exec(s);
  if (!m) return null;
  if (m[1] !== undefined || m[2] !== undefined) {
    let cp = m[1] !== undefined ? Number(m[1]) : parseInt(m[2], 16);
    if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return { ch: String.fromCodePoint(CP1252[cp] ?? cp), len: m[0].length };
  }
  if (m[4] && Object.hasOwn(NAMED, m[3])) return { ch: NAMED[m[3]], len: m[0].length };
  for (let n = m[3].length; n >= 2; n--) { const name = m[3].slice(0, n); if (LEGACY.has(name)) return { ch: NAMED[name], len: 1 + n }; }
  return null;
};
const decodeAll = s => { let out = ''; for (let i = 0; i < s.length;) { const d = s[i] === '&' ? decodeRef(s.slice(i, i + 40)) : null; if (d) { out += d.ch; i += d.len; } else out += s[i++]; } return out; };
const SEP = '\u0001'; // a block boundary: a command never runs across it
const SEPI = '\u0002'; // the edge of an inline element whose text a command may start just inside of, not run out of (see INLINE)
// Fails closed (Codex site r8 M1). A tag separates text ONLY if it is on this list: the elements that break a line of text per the HTML
// Standard's rendering section (flow and sectioning blocks, headings, lists, tables, form blocks, br/hr, option/optgroup, head-only elements).
// Every other tag, including unknown and custom elements (<x-foo>) and every inline element (label, del, ins, time, output, ruby, data, b, i...),
// is transparent, so its text joins the text around it. Over-joining can only make a false violation, which a person sees and fixes; it cannot hide a command.
const BREAKS = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div',
  'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'legend',
  'li', 'listing', 'main', 'menu', 'nav', 'ol', 'optgroup', 'option', 'p', 'plaintext', 'pre', 'rp', 'rt', 'search', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'title', 'tr', 'ul', 'xmp']);
// The one kept exception to "transparent": code / a / span / kbd / samp / var / tt mark the edge of an element a command may START just inside
// (`attessa <code>ghost</code>`) but not run out of, which the real pages need (a `<span class="ln">` output line ends where its span ends, and
// `<code>attessa init</code> and` must not read "and" as an argument). It only ever shortens what is read as one command at a boundary.
const INLINE = new Set(['code', 'a', 'span', 'kbd', 'samp', 'var', 'tt']);
const tagName = tag => /^<\/?([a-zA-Z][^\s/>]*)/.exec(tag)?.[1].toLowerCase() ?? '';
const separator = tag => { const n = tagName(tag); return BREAKS.has(n) ? SEP : INLINE.has(n) ? SEPI : ''; };
// Attributes whose value a visitor sees or a search result shows, so a command in one is a displayed command. Policy: all of them are
// scanned, input `value` and `placeholder` included, in double-quoted, single-quoted and unquoted form. (`title`, `alt` and `aria-label` are
// read out or shown on hover; `content` is the meta description; `data-*` feeds the site's own JS, which writes it into the page.)
const ATTRS = /\s(?:title|alt|aria-label|content|placeholder|value|data-[\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
const TAG = /^<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/;
// The rendered view of a document: text with character references decoded, a SEP wherever a BREAKS tag starts or ends (SEPI for
// INLINE ones), every other tag transparent, and the decoded text of the visible attributes above. Comments, scripts and styles are not rendered.
// For every character of the view, `at[i]` is its offset in the source and `attr[i]` is the attribute value it came from, if any.
const UNKNOWN_REF = /&([A-Za-z][A-Za-z0-9]*);/g;
const unknownRefs = s => [...s.matchAll(UNKNOWN_REF)].map(m => m[1]).filter(n => !Object.hasOwn(NAMED, n));
const render = raw => {
  let view = '';
  const at = [], attr = [], unknown = [];
  const put = (str, i, a) => { for (const ch of str) { view += ch; at.push(i); attr.push(a); } };
  for (let i = 0; i < raw.length;) {
    if (raw.startsWith('<!--', i)) { const e = raw.indexOf('-->', i); i = e < 0 ? raw.length : e + 3; put(SEP, i, null); continue; }
    const hide = /^<(script|style)\b/i.exec(raw.slice(i, i + 9));
    if (hide) { const e = raw.toLowerCase().indexOf(`</${hide[1].toLowerCase()}>`, i); i = e < 0 ? raw.length : e + hide[1].length + 3; put(SEP, i, null); continue; }
    if (raw[i] === '<' && /[a-zA-Z/]/.test(raw[i + 1] ?? '')) {
      const rest = raw.slice(i);
      const tag = TAG.exec(rest)?.[0] ?? rest.slice(0, rest.indexOf('>') < 0 ? rest.length : rest.indexOf('>') + 1);
      put(separator(tag), i, null);
      for (const m of tag.matchAll(ATTRS)) { unknown.push(...unknownRefs(m[1] ?? m[2] ?? m[3])); const v = decodeAll(m[1] ?? m[2] ?? m[3]); put(`${v}${SEP}`, i, v); }
      i += tag.length; continue;
    }
    if (raw[i] === '&') { const d = decodeRef(raw.slice(i, i + 40)); if (d) { put(d.ch, i, null); i += d.len; continue; } const u = /^&([A-Za-z][A-Za-z0-9]*);/.exec(raw.slice(i, i + 40)); if (u && !Object.hasOwn(NAMED, u[1])) unknown.push(u[1]); }
    put(raw[i], i, null); i++;
  }
  return { view, at, attr, unknown };
};
const tokensOf = s => s.match(/"[^"]*"|\S+/g) ?? [];
/** Why these tokens (the words after `attessa`) are not a usable command, or null. Built commands only; UNBUILT is decided by the caller. */
const reasonFor = tokens => {
  const line = tokens.join(' ');
  if (line === '--help' || line === 'seller' || line === 'seller --help') return null; // answered by index.ts before the table
  const key = tokens.length > 1 && SPECS.has(`${tokens[0]} ${tokens[1]}`) ? `${tokens[0]} ${tokens[1]}` : SPECS.has(tokens[0] ?? '') ? tokens[0] : null;
  if (!key) return 'no such command';
  const spec = SPECS.get(key);
  let rest = tokens.slice(key.split(' ').length);
  if (key === 'gateway') {
    const subs = (rest[0] ?? '').split('|');
    if (!subs.every(x => GATEWAY_SUBCOMMANDS.includes(x))) return `gateway takes ${GATEWAY_SUBCOMMANDS.join('|')}`;
    rest = rest.slice(1);
  }
  let positionals = 0;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--' || /^-/.test(t)) {
      const m = /^--([A-Za-z0-9-]+)(=.*)?$/.exec(t);
      const type = m ? spec.flags.get(m[1]) : undefined;
      if (!type) return `${t}: no such flag`;
      if (type === 'string' && m[2] === undefined) { if (i + 1 >= rest.length || /^--/.test(rest[i + 1])) return `${t}: needs a value`; i++; }
      else if (type === 'boolean' && m[2] !== undefined) return `${t}: takes no value`;
    } else positionals++;
  }
  return positionals > spec.args ? `Unexpected argument: ${rest.filter(t => !t.startsWith('-')).slice(spec.args).join(' ')}` : null;
};
// The string literals of a script (and the template literals, whose range includes their ${} expressions), as { s, e } ranges of their contents.
// Comments are skipped. A regex literal holding a quote can confuse it; the effect is a literal found wrong, and a wrong literal reports a violation.
const literalsOf = src => {
  const out = [];
  const code = (i, inBraces) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return src.length; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return src.length; i = e + 2; continue; }
      if (c === '"' || c === "'") { let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1; out.push({ s: i + 1, e: j }); i = j + 1; continue; }
      if (c === '`') { i = template(i); continue; }
      if (inBraces) { if (c === '{') depth++; else if (c === '}') { if (depth === 0) return i + 1; depth--; } }
      i++;
    }
    return i;
  };
  const template = i => {
    const lit = { s: i + 1, e: src.length };
    out.push(lit);
    let j = i + 1;
    while (j < src.length && src[j] !== '`') { if (src[j] === '\\') j += 2; else if (src[j] === '$' && src[j + 1] === '{') j = code(j + 2, true); else j++; }
    lit.e = Math.min(j, src.length);
    return j + 1;
  };
  code(0, false);
  return out;
};
/** A script with its tags replaced by SEP, and for each character of that text its offset in the original. */
const flatten = raw => {
  let flat = '';
  const map = [];
  let last = 0;
  const copy = to => { for (let k = last; k < to; k++) { flat += raw[k]; map.push(k); } };
  for (const m of raw.matchAll(/<[^>]*>/g)) { copy(m.index); flat += SEP; map.push(m.index); last = m.index + m[0].length; }
  copy(raw.length);
  return { flat, map };
};
/** Every violation in one rendered document. `isJs`: the source is a script. There an unbuilt command is exempt only when the Coming mark is in the
 *  very string literal that holds the command (for a template literal: anywhere in that template, which is the fragment it builds). Nearby text is not an association. */
const violations = (raw, isJs = false) => {
  const js = isJs ? flatten(raw) : null;
  const { view, at, attr, unknown = [] } = render(isJs ? js.flat : raw);
  const literals = isJs ? literalsOf(raw) : [];
  const literalAt = pos => literals.filter(l => l.s <= pos && pos <= l.e).sort((x, y) => (x.e - x.s) - (y.e - y.s))[0];
  const bad = isJs ? [] : unknown.map(n => `&${n};: a character reference this scanner cannot read`);
  for (const m of view.matchAll(/(?<![\w/@.:-])attessa\s+(?=[^\s\u0001])/g)) {
    const start = m.index + m[0].length;
    let tail = view.slice(start).split(SEP)[0];
    // A command may begin just inside an inline element (`attessa <code>ghost</code>`), and ends at that element's edge.
    tail = tail.startsWith(SEPI) ? tail.replace(/^\u0002+/, '').split(SEPI)[0] : tail.split(SEPI)[0];
    if (isJs) tail = tail.split(/["'`\\]/)[0]; // the end of the string literal
    tail = tail.split(/\.(?=\s|$)|,\s|;\s|:\s|\s\(|\s(?:and|or|then)\s/)[0].trim();
    if (PROSE.some(p => p.test(tail))) continue;
    const tokens = tokensOf(tail);
    const line = tokens.join(' ');
    if (UNBUILT.some(u => u.test(line))) {
      const lit = isJs ? literalAt(js.map[at[start]]) : null;
      const block = attr[start] ?? (isJs ? (lit ? raw.slice(lit.s, lit.e) : '') : enclosing(raw, at[start]));
      if (!marked.test(text(block))) bad.push(`attessa ${line}: not built, and its block does not say so`);
      continue;
    }
    const why = reasonFor(tokens);
    if (why) bad.push(`attessa ${line}: ${why}`);
  }
  return bad;
};

// The BUILT site: partials expanded. SITE_SRC, when set, is passed through to the build. The scripts the site ships are scanned too.
const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = mkdtempSync(join(tmpdir(), 'attessa-site-cli-built-'));
execFileSync(process.execPath, [join(pkg, 'build.mjs')], { cwd: pkg, stdio: 'pipe', env: { ...process.env, SITE_OUT: built } });

test('every displayed attessa command, option and argument is accepted by the CLI table, or that exact command is marked not built in its own block', () => {
  const files = walk(built).filter(f => /\.(html|js)$/.test(f));
  assert.ok(files.some(f => f.endsWith('cli-call.html') || f.includes('tutorial')), 'the built site lost its docs pages');
  const found = files.flatMap(f => violations(readFileSync(f, 'utf8'), f.endsWith('.js')).map(v => `${f.slice(built.length + 1)}: ${v}`));
  assert.deepEqual(found, []);
});

test('the built site really shows commands to check (the scan is not vacuous)', () => {
  const all = walk(built).filter(f => f.endsWith('.html')).map(f => readFileSync(f, 'utf8')).join('\n');
  assert.ok((render(all).view.match(/\battessa [a-z]/g) ?? []).length > 60);
  assert.ok(render('<p>x</p><!-- attessa ghost --><script>attessa ghost</script>').view.indexOf('ghost') < 0, 'comments and scripts are not rendered');
});

test('the command check refuses an unknown terminal command, and a bad flag beside a Coming mark (Codex site r5 mutants)', () => {
  const page = n => readFileSync(join(built, ...n), 'utf8');
  const swap = (raw, from, to) => { assert.ok(raw.includes(from), `the page lost ${from}`); return raw.replace(from, to); };
  assert.deepEqual(violations(swap(page(['how-it-works.html']), 'attessa enclave build</span></span>', 'attessa ghost --bogus</span></span>')), ['attessa ghost --bogus: no such command']);
  assert.deepEqual(violations(swap(page(['docs', 'tutorial.html']), '<code>attessa init</code> and', '<code>attessa init --bogus</code> and')), ['attessa init --bogus: --bogus: no such flag']);
  assert.deepEqual(violations('<p>Coming. <code>attessa ghost</code></p>'), ['attessa ghost: no such command']);
  assert.deepEqual(violations('<h2>Coming</h2><p><code>attessa verify</code></p>'), ['attessa verify: not built, and its block does not say so']);
});

test('an unbuilt command is exempt only in its exact shape, in a block that says so (Codex site r6 finding 1)', () => {
  assert.deepEqual(violations('<p>Coming <code>attessa verify --bogus</code></p>'), ['attessa verify --bogus: no such command']);
  assert.deepEqual(violations('<p>Optional <code>attessa call --via evil --bogus</code></p>'), ['attessa call --via evil --bogus: --via: no such flag']);
  assert.deepEqual(violations('<p>Coming <code>attessa release verify ghost x</code></p>'), ['attessa release verify ghost x: no such command']);
  assert.deepEqual(violations('<p>Optional <code>attessa call --via buy https://x --bogus</code></p>'), ['attessa call --via buy https://x --bogus: --via: no such flag']);
  assert.deepEqual(violations('<p>Coming <code>attessa verify &lt;requestId&gt;</code></p>'), []);
  assert.deepEqual(violations('<p>Optional <code>attessa call --via buy &lt;url&gt;</code></p>'), []);
});

test('a built command with an extra argument or an invalid option spelling is refused (Codex site r6 finding 2)', () => {
  assert.deepEqual(violations('<p><code>attessa init ghost</code></p>'), ['attessa init ghost: Unexpected argument: ghost']);
  assert.deepEqual(violations('<p><code>attessa init --BOGUS</code></p>'), ['attessa init --BOGUS: --BOGUS: no such flag']);
  assert.deepEqual(violations('<p><code>attessa init --0</code></p>'), ['attessa init --0: --0: no such flag']);
  assert.deepEqual(violations('<p><code>attessa call https://x extra</code></p>'), ['attessa call https://x extra: Unexpected argument: extra']);
  assert.deepEqual(violations('<p><code>attessa call --body</code></p>'), ['attessa call --body: --body: needs a value']);
  assert.deepEqual(violations('<p><code>attessa call --new=1 https://x</code></p>'), ['attessa call --new=1 https://x: --new=1: takes no value']);
  assert.deepEqual(violations('<p><code>attessa gateway ghost</code></p>'), ['attessa gateway ghost: gateway takes pause|resume|status|export']);
  assert.deepEqual(violations('<p><code>attessa call https://x --body tx.json --new</code></p>'), []);
});

test('commands outside <code> and every command in an output line are checked (Codex site r6 finding 3)', () => {
  assert.deepEqual(violations('<p><a>Coming: attessa ghost --bogus</a></p>'), ['attessa ghost --bogus: no such command']);
  assert.deepEqual(violations('<meta name="description" content="Coming: attessa ghost">'), ['attessa ghost: no such command']);
  assert.deepEqual(violations('<span class="ln">Valid. To renew: attessa signer renew. After a restart: attessa enclave start, then attessa ghost --bogus (about 4 CELO).</span>'), ['attessa ghost --bogus: no such command']);
  assert.deepEqual(violations('<span class="ln">Next: attessa signer renew. Then attessa ghost.</span>'), ['attessa ghost: no such command']);
  assert.deepEqual(violations('<p>Plain prose with attessa ghost --bogus in it.</p>'), ['attessa ghost --bogus in it: no such command']);
  assert.deepEqual(violations('const x = "<code>attessa ghost</code> text";', true), ['attessa ghost: no such command']);
  const swap = (raw, from, to) => { assert.ok(raw.includes(from), `the page lost ${from}`); return raw.replace(from, to); };
  const page = n => readFileSync(join(built, ...n), 'utf8');
  assert.deepEqual(violations(swap(page(['how-it-works.html']), 'attessa enclave start, then attessa signer register', 'attessa enclave start, then attessa ghost --bogus')), ['attessa ghost --bogus: no such command']);
  assert.deepEqual(violations(swap(page(['docs', 'index.html']), 'Coming: attessa verify.', 'Coming: attessa ghost --bogus.')), ['attessa ghost --bogus: no such command']);
  assert.deepEqual(violations('<p>attessa can\'t check that. Run <code>attessa init</code>.</p>'), []);
});

test('a command with an unbuilt modifier is not accepted just because its first word is real (attessa call --via buy)', () => {
  assert.ok(!COMMANDS.get('call').has('via'), 'call accepts --via now: remove the Optional / not built marks (T29)');
  const ref = readFileSync(join(src, 'pages', 'docs', 'reference.html'), 'utf8');
  const row = ref.split('\n').find(l => l.includes('attessa call --via buy'));
  assert.ok(row && marked.test(text(row)), 'the reference row for attessa call --via buy must stay marked Optional / not built');
});

// Codex site-finish r7 (M1): the scanner reads what a browser shows. Character references are decoded once, rendered whitespace of every kind
// separates tokens, and a command split by markup that does not break the line is still one command.
test('character-reference and whitespace mutants in a built page are caught (Codex site r7 M1)', () => {
  const page = n => readFileSync(join(built, ...n), 'utf8');
  const swap = (raw, from, to) => { assert.ok(raw.includes(from), `the page lost ${from}`); return raw.replace(from, to); };
  const mutants = [
    ['attessa&#32;ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa&#x20;ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa&#X20;ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa&#32ghost --bogus', 'attessa ghost --bogus: no such command'], // no semicolon
    ['attessa&nbsp;ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa&nbsp ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa&#160;ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa&Tab;ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa&NewLine;ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa&ensp;ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa\nghost --bogus', 'attessa ghost --bogus: no such command'],
    ['&#97;ttessa ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['&#x61;ttessa ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['&amp;#97;ttessa ghost --bogus', null], // literal text "&#97;ttessa": not a command at all
    ['attessa init&#32;--bogus', 'attessa init --bogus: --bogus: no such flag'],
    ['attessa init&nbsp;--bogus', 'attessa init --bogus: --bogus: no such flag'],
    ['attessa init --bogus', 'attessa init --bogus: --bogus: no such flag'],
    ['attessa <b>ghost</b> --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa <code>ghost</code> --bogus', 'attessa ghost: no such command'],
    ['attessa <i>gh</i>ost --bogus', 'attessa ghost --bogus: no such command'],
    ['attessa init <em>--bogus</em>', 'attessa init --bogus: --bogus: no such flag'],
    ['attessa init<b></b> --bogus', 'attessa init --bogus: --bogus: no such flag'],
    ['<b>attessa</b> ghost --bogus', 'attessa ghost --bogus: no such command'],
    ['att<b>essa</b> ghost --bogus', 'attessa ghost --bogus: no such command'],
  ];
  for (const [mutant, want] of mutants) {
    const raw = swap(page(['how-it-works.html']), 'attessa enclave build</span></span>', `${mutant}</span></span>`);
    const got = violations(raw).filter(v => !v.startsWith('attessa enclave build'));
    assert.deepEqual(got, want ? [want] : [], `mutant ${JSON.stringify(mutant)}`);
  }
  // Inside a marked-unbuilt block the exact unbuilt shape is still exempt, with an entity for its space as well.
  assert.deepEqual(violations('<p>Coming <code>attessa&#32;verify</code></p>'), []);
  assert.deepEqual(violations('<h2>Coming</h2><p><code>attessa&nbsp;verify</code></p>'), ['attessa verify: not built, and its block does not say so']);
});

test('a named reference the decoder lacks fails closed, in text and in attributes (Codex site r7 M1)', () => {
  assert.deepEqual(violations('<p>attessa&NonBreakingSpace;ghost --bogus</p>'), ['&NonBreakingSpace;: a character reference this scanner cannot read']);
  assert.deepEqual(violations('<p>&Aopf; x</p>'), ['&Aopf;: a character reference this scanner cannot read']);
  assert.deepEqual(violations('<input value="attessa&NonBreakingSpace;ghost">'), ['&NonBreakingSpace;: a character reference this scanner cannot read']);
  assert.deepEqual(violations('<p>a&amp;b; and &nbsp; x</p>'), []); // `&amp;b;` shows the text "&b;": no reference was left unread
  assert.deepEqual(violations('<script>const a = x&y;</script>'), []);
});

test('real commands written with entities still pass, and a double-encoded space is text, not whitespace (Codex site r7 M1)', () => {
  assert.deepEqual(violations('<p><code>attessa&#32;init</code> and <code>attessa&nbsp;status</code></p>'), []);
  assert.deepEqual(violations('<p><code>attessa call&#x20;https://x&#32;--body&nbsp;tx.json&#160;--new</code></p>'), []);
  assert.deepEqual(violations('<p><code>attessa&Tab;init</code> <code>att&#101;ssa&NewLine;status</code></p>'), []);
  assert.deepEqual(violations('<p><code>attessa call --body&#32;tx.json https://x</code></p>'), []);
  assert.deepEqual(violations('<p><code>attessa <b>init</b></code> <code>attessa gateway&nbsp;pause</code></p>'), []);
  // `&amp;#32;` decodes once to the text "&#32;": it does not separate `attessa` from what follows, nor tokens within a command.
  assert.deepEqual(violations('<p>attessa&amp;#32;ghost --bogus</p>'), []);
  assert.deepEqual(violations('<p><code>attessa init&amp;#32;--bogus</code></p>'), ['attessa init&#32;--bogus: no such command']);
  assert.equal(render('a&amp;#32;b').view, 'a&#32;b');
  assert.equal(render('a&#32;b&#x20;c&nbsp;d&Tab;e').view, 'a b c d\te');
  assert.equal(render('&ampx &lt &unknown; &#0;').view, '&x < &unknown; �');
});

// Policy on visible attributes (Codex site r7): SCANNED. title, alt, aria-label, content (meta description), placeholder and input value are text a
// visitor sees, hears or finds in search results, so a command in one is a displayed command; data-* is copied into the page by the site's own JS.
test('commands in visible attributes are scanned: value, placeholder, title, aria-label, alt (Codex site r7 M1)', () => {
  for (const a of ['value', 'placeholder', 'title', 'aria-label', 'alt']) {
    assert.deepEqual(violations(`<input ${a}="attessa ghost --bogus">`), ['attessa ghost --bogus: no such command'], a);
    assert.deepEqual(violations(`<img ${a}='attessa ghost --bogus'>`), ['attessa ghost --bogus: no such command'], `${a} single-quoted`);
    assert.deepEqual(violations(`<p ${a}="attessa&#32;ghost --bogus">x</p>`), ['attessa ghost --bogus: no such command'], `${a} entity`);
    assert.deepEqual(violations(`<input ${a}="attessa init">`), [], `${a} real command`);
  }
  assert.deepEqual(violations('<input value=attessa_ghost>'), []);
  assert.deepEqual(violations('<a href="x" title="Coming: attessa ghost">go</a>'), ['attessa ghost: no such command']);
  assert.deepEqual(violations('<input type="text" value="a > b" placeholder="attessa ghost">'), ['attessa ghost: no such command']);
});

// Codex site-finish r8 M1: the tag model fails closed. Only the BREAKS elements separate text; any other element, known or not, is transparent.
test('a tag not on the line-breaking list never hides a command (Codex site r8 M1)', () => {
  for (const tag of ['label', 'del', 'ins', 'time', 'output', 'ruby', 'data', 'x-foo', 'my-widget', 'blink', 'notatag', 'b', 'bdi', 'abbr', 'mark']) {
    assert.deepEqual(violations(`<p>attessa <${tag}>ghost</${tag}> --bogus</p>`), ['attessa ghost --bogus: no such command'], tag);
    assert.deepEqual(violations(`<p>attessa <${tag} class="x">ghost</${tag}> --bogus</p>`), ['attessa ghost --bogus: no such command'], `${tag} with attributes`);
    assert.deepEqual(violations(`<p><${tag}>attessa </${tag}>ghost --bogus</p>`), ['attessa ghost --bogus: no such command'], `${tag} around attessa`);
  }
  // The elements that do break a line still separate: a command does not run across them.
  for (const tag of ['p', 'div', 'li', 'td', 'h2', 'section', 'option', 'tr']) assert.deepEqual(violations(`<${tag}>attessa init</${tag}><${tag}>ghost --bogus</${tag}>`), [], tag);
  assert.deepEqual(violations('<p>attessa init<br>ghost --bogus</p>'), []);
  assert.deepEqual(violations('<p>attessa init<hr>ghost --bogus</p>'), []);
  assert.deepEqual(violations('<p>attessa <x-foo>init</x-foo></p>'), []);
});

// Codex site-finish r8 M2: in a script, an unbuilt command is exempt only inside the string literal (or template) that carries its Coming mark.
test('a script exempts an unbuilt command only when the mark is in the same literal (Codex site r8 M2)', () => {
  const raw = 'const unrelated = "Coming";' + ' '.repeat(240) + 'const command = "attessa verify";';
  assert.deepEqual(violations(raw, true), ['attessa verify: not built, and its block does not say so']);
  assert.deepEqual(violations('const a = "Coming"; const b = "attessa verify";', true), ['attessa verify: not built, and its block does not say so']);
  assert.deepEqual(violations('const a = "Coming: " + "attessa verify";', true), ['attessa verify: not built, and its block does not say so']);
  assert.deepEqual(violations('// Coming\nconst b = "attessa verify";', true), ['attessa verify: not built, and its block does not say so']);
  assert.deepEqual(violations('const a = "Coming: attessa verify";', true), []);
  assert.deepEqual(violations("const a = '<p>Coming <code>attessa verify</code></p>';", true), []);
  assert.deepEqual(violations('const a = `<p>Coming</p><p><code>attessa verify</code></p>${x}`;', true), []);
  assert.deepEqual(violations('const a = `<p>Coming ${"x"}</p>`; const b = `${y}<code>attessa verify</code>`;', true), ['attessa verify: not built, and its block does not say so']);
  assert.deepEqual(violations('const a = "attessa ghost --bogus";', true), ['attessa ghost --bogus: no such command']);
});
