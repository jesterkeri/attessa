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

import { commandOf, COMMANDS } from './lib/cli-table.mjs';

// Codex site-finish r5: every displayed command node is parsed. An unknown command fails before its flags are looked at, and only a
// command named in UNBUILT may be exempt, and only with its marker in the same block (table row, list item, paragraph, heading, figure).
// A nearby Coming or Optional never blesses a built command, or anything else.
const UNBUILT = [/^verify\b/, /^release verify\b/, /^call --via\b/];
const BLOCKS = ['tr', 'li', 'p', 'h2', 'h3', 'figure'];
const enclosing = (raw, at) => {
  const open = BLOCKS.flatMap(tag => {
    const starts = [...raw.slice(0, at).matchAll(new RegExp(`<${tag}[\\s>]`, 'g'))];
    const start = starts.length ? starts[starts.length - 1].index : -1;
    return start > raw.lastIndexOf(`</${tag}>`, at) ? [{ tag, start }] : [];
  }).sort((x, y) => y.start - x.start)[0];
  return open ? raw.slice(open.start, raw.indexOf(`</${open.tag}>`, at)) : '';
};
const NODE = /(?:<code>|<span class="c">|(?:Next:|restart:|key\):|, then) )(?:<[^>]*>)*\s*attessa ([^<]*(?:<span[^>]*>[^<]*<\/span>[^<]*)*)/g;
const violations = raw => {
  const bad = [];
  for (const m of raw.matchAll(NODE)) {
    const line = text(m[1]).split(/\. |, then |\s\(/)[0].replace(/\.$/, '');
    if (UNBUILT.some(u => u.test(line))) {
      if (!marked.test(text(enclosing(raw, m.index)))) bad.push(`attessa ${line}: not built, and its block does not say so`);
      continue;
    }
    if (line === '--help' || line === 'seller --help') continue; // the two usage paths index.ts answers before the table
    const tokens = line.split(/\s+/);
    const words = tokens.slice(0, tokens.findIndex(w => !/^[a-z][a-z|-]*$/.test(w)) + 1 || tokens.length).filter(w => /^[a-z][a-z|-]*$/.test(w));
    const key = commandOf(words);
    if (!key) { bad.push(`attessa ${line}: no such command`); continue; }
    for (const flag of line.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)) {
      if (!COMMANDS.get(key).has(flag[1])) bad.push(`attessa ${key} --${flag[1]}: no such flag`);
    }
  }
  return bad;
};

test('every displayed attessa command and flag exists, or that exact command is marked not built in its own block', () => {
  const nodes = walk(src).filter(f => f.endsWith('.html')).flatMap(f => violations(readFileSync(f, 'utf8')).map(v => `${f.slice(src.length + 1)}: ${v}`));
  assert.deepEqual(nodes, []);
});

test('the command check refuses an unknown terminal command, and a bad flag beside a Coming mark (Codex site r5 mutants)', () => {
  const page = n => readFileSync(join(src, 'pages', ...n), 'utf8');
  const swap = (raw, from, to) => { assert.ok(raw.includes(from), `the page lost ${from}`); return raw.replace(from, to); };
  assert.deepEqual(violations(swap(page(['how-it-works.html']), 'attessa enclave build</span></span>', 'attessa ghost --bogus</span></span>')), ['attessa ghost --bogus: no such command']);
  assert.deepEqual(violations(swap(page(['docs', 'tutorial.html']), '<code>attessa init</code> and', '<code>attessa init --bogus</code> and')), ['attessa init --bogus: no such flag']);
  assert.deepEqual(violations('<p>Coming. <code>attessa ghost</code></p>'), ['attessa ghost: no such command']);
  assert.deepEqual(violations('<h2>Coming</h2><p><code>attessa verify</code></p>'), ['attessa verify: not built, and its block does not say so']);
});

test('a command with an unbuilt modifier is not accepted just because its first word is real (attessa call --via buy)', () => {
  assert.ok(!COMMANDS.get('call').has('via'), 'call accepts --via now: remove the Optional / not built marks (T29)');
  const ref = readFileSync(join(src, 'pages', 'docs', 'reference.html'), 'utf8');
  const row = ref.split('\n').find(l => l.includes('attessa call --via buy'));
  assert.ok(row && marked.test(text(row)), 'the reference row for attessa call --via buy must stay marked Optional / not built');
});
