// Adversary round 19 on the site (5ff468a..9d9bda2). Intended home: site/test/cli-output-verbatim.test.mjs
// Run from the repo root: node --test site/test/cli-output-verbatim.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src; FLOWS.md is read from SITE_SRC/../../FLOWS.md or FLOWS_MD)
//
// Every terminal block on the site that shows what the CLI prints must quote FLOWS §6 verbatim
// (AGENTS.md: "FLOWS.md §6 and §8 for every user-facing string (verbatim)"). FLOWS §6 puts two spaces
// before a muted part only where the dialog itself does; three site lines add a second space that FLOWS
// does not have:
//   FLOWS §6 J0: "→ Wallet: none found. Created one for this computer: 0x51c2…9e (key stored ...)"
//   FLOWS §6 J3: "→ Starting the sealed machine from build/risk.eif… running (Nitro enclave, 1 vCPU, 1 GiB)"
//   FLOWS §6 J5: "→ Paid 0.005 USDC through buy (tx 0x…)"
// The J3 line is built (T15 ticked) and packages/cli/src/copy.ts `starting` prints it with one space,
// so the how-it-works walkthrough shows output the shipped CLI does not print.
// A line may stop early (an excerpt), but what it shows must appear in FLOWS §6 character for character.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const flowsPath = process.env.FLOWS_MD ?? join(src, '..', '..', 'FLOWS.md');
const flows = readFileSync(flowsPath, 'utf8');
const s6 = flows.slice(flows.indexOf('## 6. Sample dialogs'), flows.indexOf('## 7. State inventory'));
const dialogLines = [...s6.matchAll(/```\n([\s\S]*?)```/g)].flatMap(m => m[1].split('\n'));

const decode = h => h.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const files = dir => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : []));

// Output lines the site shows in terminal blocks: the arrow lines the CLI prints.
const outputLines = files(src).flatMap(f => [...readFileSync(f, 'utf8').matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)]
  .flatMap(m => decode(m[1]).split('\n'))
  .filter(l => l.startsWith('→'))
  .map(l => ({ file: f.slice(src.length + 1), line: l })));

test('FLOWS §6 dialogs were found (precondition)', () => {
  assert.ok(dialogLines.length > 50, `only ${dialogLines.length} dialog lines read from ${flowsPath}`);
  assert.ok(outputLines.length > 20, `only ${outputLines.length} CLI output lines found on the site`);
});

test('every CLI output line the site shows is a verbatim FLOWS §6 line (or the start of one)', () => {
  const drift = outputLines.filter(({ line }) => !dialogLines.some(d => d.startsWith(line)));
  assert.deepEqual(drift.map(d => `${d.file}: ${JSON.stringify(d.line)}`), []);
});
