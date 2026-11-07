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

// Codex site-finish r4: the test above resolves only the first word or two, so it let `attessa call --via buy` through because `call` is real,
// and never looked at flags. This one resolves the command exactly (longest match in the CLI's table) and checks each flag shown with it.
import { commandOf, COMMANDS } from './lib/cli-table.mjs';

test('every flag shown with an attessa command is a flag that exact command accepts, unless the page marks it not built', () => {
  const bad = [];
  for (const f of walk(src).filter(f => f.endsWith('.html'))) {
    const raw = readFileSync(f, 'utf8');
    for (const m of raw.matchAll(/(?:<code>|<span class="c">)(?:<[^>]*>)*\s*attessa ([^<]*(?:<span[^>]*>[^<]*<\/span>[^<]*)*)/g)) {
      const line = text(m[1]);
      const words = line.split(/\s+/).filter(w => /^[a-z][a-z-]*$/.test(w));
      const key = commandOf(words);
      if (!key || key === 'gateway') continue;
      // A table row marks itself; anything else is marked by its section (from the nearest <h2> to the next one).
      const row = raw.lastIndexOf('<tr', m.index) > raw.lastIndexOf('</tr>', m.index);
      const start = row ? raw.lastIndexOf('<tr', m.index) : Math.max(0, raw.lastIndexOf('<h2', m.index));
      const end = row ? raw.indexOf('</tr>', m.index) : (raw.indexOf('<h2', m.index) < 0 ? raw.length : raw.indexOf('<h2', m.index));
      if (marked.test(text(raw.slice(start, end)))) continue;
      for (const flag of line.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)) {
        if (!COMMANDS.get(key).has(flag[1])) bad.push(`${f.slice(src.length + 1)}: attessa ${key} --${flag[1]}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'flags shown for a built command that packages/cli/src/index.ts does not accept for it');
});

test('a command with an unbuilt modifier is not accepted just because its first word is real (attessa call --via buy)', () => {
  assert.ok(!COMMANDS.get('call').has('via'), 'call accepts --via now: remove the Optional / not built marks (T29)');
  const ref = readFileSync(join(src, 'pages', 'docs', 'reference.html'), 'utf8');
  const row = ref.split('\n').find(l => l.includes('attessa call --via buy'));
  assert.ok(row && marked.test(text(row)), 'the reference row for attessa call --via buy must stay marked Optional / not built');
});
