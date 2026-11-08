// Codex site-finish r4: the reference's CLI tables name each command and flag exactly as packages/cli/src/index.ts does.
//   - every <code> in the first column is a full command: `attessa <command words>` (no bare `wallet-sig` or `set-wallet`);
//   - the command words exist in the CLI's command table, unless the row is marked Coming or Optional (verify, release verify,
//     call --via buy);
//   - every flag the row's description shows is a flag that command accepts (its own, or a global one), unless the row is marked;
//   - the page does not advertise `attessa --help` as a full command list: the CLI's usage path prints only the seller summary and its steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, GATEWAY_SUBCOMMANDS, commandOf } from './lib/cli-table.mjs';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ref = readFileSync(join(src, 'pages', 'docs', 'reference.html'), 'utf8');
const cli = ref.slice(ref.indexOf('id="cli"'), ref.indexOf('id="tools"'));
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const UNBUILT = /\b(Coming|Optional|not built)\b/i;
const rows = [...cli.matchAll(/<tr><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><\/tr>/g)].map(m => ({
  cmds: [...m[1].matchAll(/<code>([\s\S]*?)<\/code>/g)].map(c => text(c[1])), what: m[2], whatText: text(m[2]),
}));

test('reference commands: the table parses (precondition)', () => {
  assert.ok(rows.length >= 20, `only ${rows.length} rows parsed`);
  assert.ok(COMMANDS.has('agent wallet-sig') && COMMANDS.has('agent set-wallet'), 'the CLI table parse lost the agent commands');
});

test('reference commands: every command in the first column is a full `attessa ...` command', () => {
  const bare = rows.flatMap(r => r.cmds).filter(c => !c.startsWith('attessa '));
  assert.deepEqual(bare, [], 'a first-column <code> is not a complete command (copying it would fail: Unknown command)');
});

test('reference commands: the agent transfer row names agent transfer, agent wallet-sig and agent set-wallet in full', () => {
  const all = rows.flatMap(r => r.cmds);
  for (const c of ['attessa agent transfer', 'attessa agent wallet-sig', 'attessa agent set-wallet']) assert.ok(all.includes(c), `the reference lost ${c}`);
});

test('reference commands: each built command exists in the CLI table, and each flag its row shows is accepted by it', () => {
  const bad = [];
  for (const r of rows) {
    const marked = UNBUILT.test(r.whatText);
    for (const c of r.cmds) {
      const words = c.replace(/<[^>]*>|[<][^>]*[>]/g, ' ').split(/\s+/).slice(1).filter(w => /^[a-z|-]+$/.test(w) && !w.startsWith('-'));
      const flat = c.includes('|') ? words.flatMap(w => w.split('|')) : words;
      const key = commandOf(flat);
      if (key === 'gateway') {
        const subs = c.replace(/^attessa gateway /, '').split('|');
        if (!marked && JSON.stringify(subs) !== JSON.stringify(GATEWAY_SUBCOMMANDS)) bad.push(`${c}: gateway takes ${GATEWAY_SUBCOMMANDS.join('|')}`);
        continue;
      }
      if (!key) { if (!marked) bad.push(`${c}: not a command in packages/cli/src/index.ts`); continue; }
      if (marked) continue;
      const allowed = COMMANDS.get(key);
      for (const f of new Set([...c.matchAll(/--[a-z][a-z-]*/g), ...[...r.what.matchAll(/<code>(--[a-z][a-z-]*)/g)]].map(m => m[1] ?? m[0]).map(x => x.replace(/^--/, '')))) {
        if (!allowed.has(f)) bad.push(`${c}: --${f} is not a flag of attessa ${key}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('reference commands: the page does not advertise --help as a full command list', () => {
  const t = text(ref);
  assert.doesNotMatch(t, /attessa --help[^.]*(full|every|all) (list|command)|full list[^.]*--help/i);
  for (const m of t.matchAll(/--help/g)) {
    const around = t.slice(Math.max(0, m.index - 120), m.index + 200);
    assert.match(around, /seller/i, `--help is mentioned without saying it prints only the seller summary and its steps: ${around}`);
  }
});
