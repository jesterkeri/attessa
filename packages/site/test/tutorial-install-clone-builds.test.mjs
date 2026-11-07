// Adversary round 31 on the site fixes (5ff468a..c2d5a79). Intended home: packages/site/test/tutorial-install-clone-builds.test.mjs
// Run from the repo root: node --test packages/site/test/tutorial-install-clone-builds.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The tutorial's Install step, with no Coming marker, says: "git clone https://github.com/jesterkeri/attessa",
// "pnpm install --frozen-lockfile && pnpm -r build", "cd packages/cli && pnpm link --global", then
// "This builds it from source and puts attessa on your PATH." The home page's "Install from source"
// step links here. A plain clone checks out the default branch.
//
// Provenance (read-only, 2026-11-04): `gh api repos/jesterkeri/attessa --jq .default_branch` prints
// `main`; a fresh `git clone --depth 1 https://github.com/jesterkeri/attessa` checks out main at da336d4
// ("T01 prep"), which has no package.json, no pnpm-lock.yaml and no packages/. `pnpm install
// --frozen-lockfile` there fails with "ERR_PNPM_NO_PKG_MANIFEST No package.json found", and
// `cd packages/cli` fails with "No such file or directory". The packages exist only on staging.
//
// PREFLIGHT.md line 6 "- [ ] Clean clone builds: `git clone … && pnpm install --frozen-lockfile &&
// pnpm -r build …`" is not ticked, so the site may not present a clean-clone build as working today.
// The step passes this test if it names a branch that has the code (-b / --branch), carries a
// Coming / not-built / once-live marker, or PREFLIGHT's clean-clone line is ticked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const root = join(src, '..', '..', '..');
const page = p => readFileSync(join(src, 'pages', p), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const marked = /\b(coming|not built|isn't built|aren't built|not yet built|not available yet|once live|when live|planned)\b/i;

const tutorial = page('docs/tutorial.html');
const start = tutorial.indexOf('<h2 id="install">');
const step = text(tutorial.slice(start, tutorial.indexOf('</li>', start)));

test('the tutorial install step clones the repo and builds packages/cli from it (precondition)', () => {
  assert.ok(start >= 0, 'tutorial has no install step');
  assert.match(step, /git clone https:\/\/github\.com\/jesterkeri\/attessa/);
  assert.match(step, /pnpm install --frozen-lockfile && pnpm -r build/);
  assert.match(step, /cd packages\/cli && pnpm link --global/);
  assert.match(step, /This builds it from source and puts attessa on your PATH/);
});

test('the clean-clone install is not presented as working while PREFLIGHT says it is not done', () => {
  const preflight = readFileSync(join(root, 'PREFLIGHT.md'), 'utf8');
  const ticked = /^- \[x\] Clean clone builds/im.test(preflight);
  const namesBranch = /git clone (?:-b|--branch)\s+\S+/.test(step) || /git clone \S+ (?:-b|--branch)\s+\S+/.test(step);
  assert.ok(
    ticked || namesBranch || marked.test(step),
    `tutorial install step tells readers a plain clone builds, but the default branch (main) has no package.json or packages/ ` +
      `and PREFLIGHT.md "Clean clone builds" is unticked. Step text: "${step.trim()}"`,
  );
});
