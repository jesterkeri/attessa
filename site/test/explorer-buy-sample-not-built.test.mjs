// Adversary round 18 on the site (5ff468a..a9ec157, newest fixes 23d3c93..a9ec157).
// Intended home: site/test/explorer-buy-sample-not-built.test.mjs
// Run from the repo root: node --test site/test/explorer-buy-sample-not-built.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 23d3c93..a9ec157 heads the explorer's "Unattested" sample "Sample of what the buyer's SDK shows, for settlement
// tx {settlementTx}" (REF.sdkTx), and its rows and verdict now say "The buyer's SDK got no proof with the answer"
// and "The buyer's SDK saw no proof offered". The sample is a purchase "through buy".
//
// Buying through buy is not built:
// - SPEC §8: "**Optional (post-Nov 2):** `attessa call --via buy <url> [--accept-unprotected]` (J5)."
// - SPEC §7: `'unattested' // --via buy, no proof offered`; TASKS.md T29 (`attessa call --via buy`) is unticked.
// - staging's SDK writes only `via: 'gateway'` evidence (packages/sdk/src/client.ts) and nothing in packages/
//   returns the `unattested` outcome.
// - the site itself marks it: reference "Optional, not built yet", how-to #buy "Optional, not built yet".
// The explorer's preview bar marks the rejected samples as needing planned features, and the settled sample says
// "proof checks planned", but nothing marks this one, so it shows a not-built SDK path as what the SDK shows today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8');
const explorer = readFileSync(join(src, 'pages', 'explorer.html'), 'utf8');
const m = js.match(/(const chip = name =>[\s\S]*?\n {2}const STATES = \{[\s\S]*?\n {2}\};)/);
const { STATES } = m ? vm.runInNewContext(`${m[1]}\n({ STATES });`, { copySvg: '' }) : {};
const text = v => String(typeof v === 'function' ? v() : v ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const marked = /\b(coming|optional|planned|not built|isn't built|aren't built|not yet built|not available yet)\b/i;

// The header line a sample is rendered under: REF[st.ref || 'tx'] in renderChecklist.
const refText = key => {
  const body = js.match(/const REF = \{([\s\S]*?)\n {2}\};/)?.[1] ?? '';
  const line = body.match(new RegExp(`\\b${key}: \\(\\) => ([\`"'])([\\s\\S]*?)\\1,`))?.[2] ?? '';
  return text(line);
};

test('the unattested sample is a buy purchase (precondition)', () => {
  assert.ok(STATES?.unattested, 'precondition: no "unattested" sample in site.js');
  assert.match(text(STATES.unattested.rows[4].line), /through buy/, 'precondition: the sample is no longer a buy purchase');
  assert.match(explorer, /class="preview-bar"/, 'precondition: the explorer preview bar moved');
});

test('a buyer-SDK sample of a buy purchase says buying through buy is not built', () => {
  const st = STATES.unattested;
  const all = [refText(st.ref || 'tx'), ...st.rows.flatMap(r => [text(r.line), text(r.term)]), text(st.verdictLine)].join(' ');
  const saysSdk = /buyer's SDK/i.test(all);
  // The bar's own sentence, not the picker's option labels.
  const bar = text(explorer.match(/<div class="preview-bar">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? '');
  const barMarksBuy = /\b(unattested|buy)\b/i.test(bar) && marked.test(bar);
  assert.equal(saysSdk && !marked.test(all) && !barMarksBuy, false,
    `SPEC §8 lists \`attessa call --via buy\` as "Optional (post-Nov 2)" and TASKS T29 is unticked, but the sample reads: "${all.slice(0, 260)}..."`);
});
