// Adversary round 28 on the site (5ff468a..97ba657, newest fix 97ba657).
// Intended home: packages/site/test/buy-optional-not-coming.test.mjs
// Run from the repo root: node --test packages/site/test/buy-optional-not-coming.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// SPEC.md §8 lists `attessa call --via buy` under "Optional (post-Nov 2)" and TASKS.md T29 is
// "(optional, after Nov 2)", unticked. The reference defines the two labels: "Rows marked Coming are
// planned but not built yet. Rows marked Optional may not ship." and marks the buy row "Optional, not
// built yet."; how-to.html#buy says the same. 97ba657 moved the docs menu's buy link from "Coming" to
// "Optional, not built yet" ("the label the reference and T29 use"). Two summaries of the same how-to
// still promise buy as "Coming", which by the reference's own legend means planned:
//   - docs/index.html How-tos card: "Run a seller. Coming: revoke a build, use Attessa from an MCP
//     agent or with buy."
//   - docs/how-to.html meta description (search and link previews): "Run a seller. Coming: revoke a
//     build or a signer, use Attessa from an MCP agent, and use it with buy."
// A summary that names buy must not put it under "Coming"; it needs the Optional label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = p => readFileSync(join(src, p), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

test('the reference, the how-to and the docs menu label buy Optional (precondition)', () => {
  const ref = text(read('pages/docs/reference.html'));
  assert.match(ref, /Rows marked Coming are planned but not built yet\. Rows marked Optional may not ship\./);
  assert.match(ref, /attessa call --via buy <url> Optional, not built yet\./);
  const howto = read('pages/docs/how-to.html');
  assert.match(text(howto.slice(howto.indexOf('id="buy"'))), /Use it with buy Optional, not built yet\./);
  assert.match(text(read('partials/docs-nav.html')), /Use it with buy Optional, not built yet/);
});

// Each "Coming" list: from "Coming" up to the next full stop.
const comingLists = t => [...t.matchAll(/Coming[:.]?([^.]*)/g)].map(m => m[0]);

for (const [where, get] of [
  ['docs/index.html How-tos card', () => {
    const card = read('pages/docs/index.html').match(/<a href="how-to\.html">([\s\S]*?)<\/a>/);
    assert.ok(card, 'precondition: docs/index.html has no How-tos card');
    return text(card[1]);
  }],
  ['docs/how-to.html meta description', () => {
    const m = read('pages/docs/how-to.html').match(/^<!--\s*description:\s*(.*?)\s*-->/m);
    assert.ok(m, 'precondition: how-to.html has no description');
    return m[1];
  }],
]) {
  test(`${where} does not promise buy as Coming`, () => {
    const t = get();
    assert.match(t, /\bbuy\b/, `${where} no longer mentions buy`);
    const promised = comingLists(t).filter(c => /\bbuy\b/.test(c));
    assert.deepEqual(promised, [],
      `${where}: "${t}" lists buy as Coming (planned); SPEC §8 "Optional (post-Nov 2)", TASKS T29 optional, and the reference, how-to and docs menu say "Optional, not built yet"`);
  });
}
