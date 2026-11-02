// Adversary round 1 on the site fixes (773e072..aad82a8). Intended home: site/test/home-checks-count.test.mjs
// Run from the repo root: node --test site/test/home-checks-count.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 1acc903 changed the homepage story step "You pay only if the proof checks out" to say the gateway
// pays "only after all four checks pass". The 3D scene that plays beside that same step (story
// progress s from 3.0 to 3.85, scene.js) still lights the approved machine's corner dots one per
// check, up to five. The copy and the picture beside it now give different counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

test('the story step that names how many checks pass lights the same number of corner dots', () => {
  const home = readFileSync(join(src, 'pages', 'index.html'), 'utf8');
  const steps = [...home.matchAll(/<li data-step[^>]*>([\s\S]*?)<\/li>/g)].map(m => m[1]);
  const idx = steps.findIndex(s => /all (\w+) checks pass/.test(s));
  assert.notEqual(idx, -1, 'no story step states a number of checks');
  const said = WORDS[steps[idx].match(/all (\w+) checks pass/)[1]];

  // scene.js: checks: ramp(s, a, b) * N, where s is story progress in steps (step k spans k..k+1).
  const scene = readFileSync(join(src, 'static', 'assets', 'scene.js'), 'utf8');
  const m = scene.match(/checks:\s*ramp\(s,\s*([\d.]+),\s*([\d.]+)\)\s*\*\s*(\d+)/);
  assert.ok(m, 'scene.js no longer animates the checks');
  assert.equal(Math.floor(Number(m[1])), idx, 'the checks animation plays beside a different story step');
  const lit = Number(m[3]);

  assert.equal(lit, said, `story step ${idx + 1} says ${said} checks pass, but the scene beside it lights ${lit} corner dots`);
});
