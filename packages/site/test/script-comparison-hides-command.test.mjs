// Adversary site-finish r2. Intended home: packages/site/test/script-comparison-hides-command.test.mjs
// Run from the repo root: node --test packages/site/test/script-comparison-hides-command.test.mjs
// (or from anywhere: SITE_PKG=<repo>/packages/site node --test <this file>)
//
// use-cases-cli-built.test.mjs scans the site's own scripts for `attessa <command>` in string literals. Its flatten() turns every
// `<[^>]*>` of a script into a boundary so that HTML held in a string ("<code>attessa verify</code>") is read as markup. But a
// comparison operator `<` in the script's own code starts the same match, and it runs to the next `>` (an arrow `=>` will do), so
// everything between them, string literals included, is replaced by a boundary and never scanned.
// Spec (the scanner's own header): "every `attessa ...` any page shows is a real command ... unless that page marks it Coming".
// A script literal that shows `attessa verify` with no Coming mark must be reported wherever it sits in the file.
//
// The scanner is not exported, so its source is cut out of the test file at run time (from `const UNBUILT` to `// The BUILT site`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkg = process.env.SITE_PKG ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const here = join(pkg, 'test');
const file = readFileSync(join(here, 'use-cases-cli-built.test.mjs'), 'utf8');
const start = file.indexOf('const UNBUILT =');
const end = file.indexOf('// The BUILT site');
assert.ok(start > 0 && end > start, 'the scanner moved: update the cut points');
const header = [
  `import { SPECS, GATEWAY_SUBCOMMANDS } from ${JSON.stringify(pathToFileURL(join(here, 'lib', 'cli-table.mjs')).href)};`,
  file.match(/^const text = .*$/m)[0],
  file.match(/^const marked = .*$/m)[0],
].join('\n');
const dir = mkdtempSync(join(tmpdir(), 'attessa-scanner-'));
const mod = join(dir, 'scanner.mjs');
writeFileSync(mod, `${header}\n${file.slice(start, end)}\nexport { violations };\n`);
const { violations } = await import(pathToFileURL(mod).href);

const NOT_BUILT = ['attessa verify: not built, and its block does not say so'];

test('control: a bare literal with an unmarked unbuilt command is reported', () => {
  assert.deepEqual(violations("const msg = 'attessa verify';", true), NOT_BUILT);
});

test('a `<` comparison earlier in a script does not hide a command literal before the next `>` (adversary site-finish r2)', () => {
  assert.deepEqual(violations("const msg = n < 3 ? 'attessa verify' : 'ok'; xs.map(x => x);", true), NOT_BUILT, 'ternary on a comparison, then an arrow');
  assert.deepEqual(violations("for (let i = 0; i < n; i++) { el.textContent = 'attessa verify'; } const f = a => a;", true), NOT_BUILT, 'for loop, then an arrow');
  assert.deepEqual(violations("if (a < b) { label = 'attessa ghost --bogus'; } if (c > d) {}", true), ['attessa ghost --bogus: no such command'], 'a bad flag too');
});

test('the same hole on the real site.js: a command added after its `r.bottom <= innerHeight` line is not seen', () => {
  const real = readFileSync(join(pkg, 'src', 'static', 'assets', 'site.js'), 'utf8').split('\n');
  const at = real.findIndex(l => l.includes('r.bottom <= innerHeight; };'));
  assert.ok(at > 0, 'site.js lost the line this test anchors on');
  const mutated = [...real.slice(0, at + 1), "      const shown = 'attessa verify';", ...real.slice(at + 1)].join('\n');
  assert.deepEqual(violations(mutated, true).filter(v => v.startsWith('attessa verify')), NOT_BUILT);
});
