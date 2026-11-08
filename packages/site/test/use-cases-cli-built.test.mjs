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
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'", apos: "'" };
const SEP = '\u0001';
// The rendered view of a document: text with entities decoded, a SEP wherever a tag starts or ends, and the text of title / alt / aria-label /
// content / data-* attributes (a meta description is shown in search results). Comments, scripts and styles are not rendered. For every
// character of the view, `at[i]` is its offset in the source and `attr[i]` is the attribute value it came from, if any.
const render = raw => {
  let view = '';
  const at = [], attr = [];
  const put = (str, i, a) => { for (const ch of str) { view += ch; at.push(i); attr.push(a); } };
  for (let i = 0; i < raw.length;) {
    if (raw.startsWith('<!--', i)) { const e = raw.indexOf('-->', i); i = e < 0 ? raw.length : e + 3; put(SEP, i, null); continue; }
    const hide = /^<(script|style)\b/i.exec(raw.slice(i, i + 9));
    if (hide) { const e = raw.toLowerCase().indexOf(`</${hide[1].toLowerCase()}>`, i); i = e < 0 ? raw.length : e + hide[1].length + 3; put(SEP, i, null); continue; }
    if (raw[i] === '<' && /[a-zA-Z/]/.test(raw[i + 1] ?? '')) {
      const e = raw.indexOf('>', i);
      const tag = raw.slice(i, e < 0 ? raw.length : e + 1);
      put(SEP, i, null);
      for (const m of tag.matchAll(/\s(?:title|alt|aria-label|content|placeholder|data-[\w-]+)="([^"]*)"/g)) put(`${m[1]}${SEP}`, i, m[1]);
      i += tag.length; continue;
    }
    if (raw[i] === '&') { const m = /^&(#39|lt|gt|amp|quot|apos);/.exec(raw.slice(i, i + 7)); if (m) { put(ENT[m[1]], i, null); i += m[0].length; continue; } }
    put(raw[i], i, null); i++;
  }
  return { view, at, attr };
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
/** Every violation in one rendered document. `isJs`: the source is a script, so the block that must carry the marker is its source line. */
const violations = (raw, isJs = false) => {
  const { view, at, attr } = isJs ? (() => { const r = render(raw.replace(/<[^>]*>/g, SEP)); return { view: r.view, at: [...r.view].map((_, i) => i), attr: r.attr }; })() : render(raw);
  const source = isJs ? raw.replace(/<[^>]*>/g, SEP) : raw;
  const bad = [];
  for (const m of view.matchAll(/(?<![\w/@.:-])attessa[ \t]+(?=[^\s\u0001])/g)) {
    const start = m.index + m[0].length;
    let tail = view.slice(start).split(SEP)[0];
    if (isJs) tail = tail.split(/["'`\\]/)[0]; // the end of the string literal
    tail = tail.split(/\.(?=\s|$)|,\s|;\s|:\s|\s\(|\s(?:and|or|then)\s/)[0].trim();
    if (PROSE.some(p => p.test(tail))) continue;
    const tokens = tokensOf(tail);
    const line = tokens.join(' ');
    if (UNBUILT.some(u => u.test(line))) {
      const block = attr[start] ?? (isJs ? source.slice(Math.max(source.lastIndexOf('\n', at[start]) + 1, at[start] - 300), at[start] + 300) : enclosing(raw, at[start]));
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
