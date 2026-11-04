// Adversary round 30 on the site (5ff468a..8f918de). Intended home: site/test/reference-next-step-unbuilt-marked.test.mjs
// Run from the repo root: node --test site/test/reference-next-step-unbuilt-marked.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The reference's CLI table marks each unbuilt command: `attessa call --via buy <url>` is "Optional, not
// built yet." (SPEC §8 "Optional (post-Nov 2)", TASKS T29 unticked) and `attessa init` / `attessa status`
// / `attessa selflink` are "Coming." (TASKS T21 unticked). The refusal table below it then gives those
// same commands as the one next step, with no marker, for codes the built code returns today:
//
// - endpoint_not_registered (packages/sdk/src/client.ts, T20 ticked): "Pay without protection with
//   `--via buy`, or ask the seller to register." `--via buy` is optional and may never ship.
// - release_exists (packages/cli `release approve`, T15 ticked): "None: `attessa status` shows it."
// - endpoint_retired, liveness_failed, result_not_found, max_amount_required, no_wallet: `attessa status`
//   or `attessa init`, both Coming.
//
// The rule (and built-state-consistent / unbuilt-commands-marked): the site may not present anything
// not built as available now; an unbuilt item must say Coming, or Optional, not built yet.
// Either fix passes: mark the unbuilt command in the row, or give a next step that exists today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ref = readFileSync(join(src, 'pages', 'docs', 'reference.html'), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const cells = row => [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(m => m[1]);
const UNBUILT = /\b(Coming|Optional|not built|planned)\b/i;

// Commands the reference's own CLI tables mark as not built, keyed by the words before the first argument.
function unbuiltCommands() {
  const cli = ref.slice(ref.indexOf('id="cli"'), ref.indexOf('id="tools"'));
  const keys = [];
  for (const m of cli.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const [cmd, what] = cells(m[1]);
    if (!cmd || !UNBUILT.test(text(what))) continue;
    const first = text(cmd.match(/<code>([\s\S]*?)<\/code>/)[1]);
    keys.push(first.split(/ (?=<|\w+\|)/)[0].split('|')[0].trim());
  }
  return keys;
}

// Commands a refusal row's next step tells you to run. A bare `--via buy` is `attessa call --via buy`.
const cited = next => [
  ...[...next.matchAll(/attessa [a-z-]+(?: --?[a-z-]+(?: buy)?| [a-z]+)?/g)].map(m => m[0]),
  ...(/(^|[^a-z])--via buy/.test(next) && !/attessa call --via buy/.test(next) ? ['attessa call --via buy'] : []),
];

test('the CLI table marks `attessa call --via buy` and `attessa status` as not built (precondition)', () => {
  const keys = unbuiltCommands();
  for (const k of ['attessa call --via buy', 'attessa status', 'attessa init']) {
    assert.ok(keys.includes(k), `CLI table parse lost ${k}; got ${keys.join(', ')}`);
  }
  assert.ok(!keys.includes('attessa signer register'), 'signer register is built (T15) and must not parse as unbuilt');
});

test('no refusal row offers an unbuilt command as its next step without saying so', () => {
  const keys = unbuiltCommands().sort((a, b) => b.length - a.length);
  const table = ref.slice(ref.indexOf('id="refusals"'));
  const bad = [];
  for (const m of table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const c = cells(m[1]);
    if (c.length < 3) continue;
    const [code, meaning, next] = c.map(text);
    for (const cmd of cited(next)) {
      const key = keys.find(k => cmd === k || cmd.startsWith(`${k} `));
      if (key && !UNBUILT.test(`${meaning} ${next}`)) bad.push(`${code}: "${next}" (${key} is marked not built in the CLI table)`);
    }
  }
  assert.deepEqual(bad, [], `refusal rows whose one next step is a command the same page says isn't built:\n  ${bad.join('\n  ')}`);
});
