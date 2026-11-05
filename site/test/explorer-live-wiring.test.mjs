// How the live payment check is wired into the page: chain data never parsed as HTML, no CDN dependency,
// readable without JavaScript, and the UI preview never shown as a live result.
// Run from the repo root: node --test site/test/explorer-live-wiring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { src, explorerJs, loadLive } from './lib/live.mjs';

const page = readFileSync(join(src, 'pages', 'explorer.html'), 'utf8');
const layout = readFileSync(join(src, 'layout.html'), 'utf8');
const site = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8');
const code = explorerJs.replace(/(^|\s)\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

test('explorer.js never parses a string as HTML or code', () => {
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'createContextualFragment', 'DOMParser', 'srcdoc']) {
    assert.ok(!code.includes(sink), `explorer.js uses ${sink}`);
  }
});

test('explorer.js talks only to the pinned RPC and links only to the pinned block explorer', () => {
  const urls = [...new Set(code.match(/https?:\/\/[^'"`\s)]+/g))].sort();
  assert.deepEqual(urls, ['http://www.w3.org/2000/svg', 'https://celo-sepolia.blockscout.com/tx/', 'https://forno.celo-sepolia.celo-testnet.org']);
  assert.equal((code.match(/\bfetch\(/g) ?? []).length, 1, 'one fetch call site');
  assert.match(code, /await fetch\(net\.rpc,/);
  assert.match(code, /credentials: 'omit'/);
});

test('the check does not depend on GSAP, ScrollTrigger, three.js or any CDN', () => {
  assert.ok(!/\b(gsap|ScrollTrigger|THREE|three|import\s*\(|importScripts)\b/.test(code));
  const tag = page.match(/<script[^>]*src="\{\{root\}\}assets\/explorer\.js"[^>]*>/)?.[0];
  assert.ok(tag, 'explorer.html does not load assets/explorer.js');
  assert.ok(!/\b(defer|async|type="module")\b/.test(tag), 'explorer.js must run before the deferred site.js handles ?q=');
  assert.match(layout, /<script src="\{\{root\}\}assets\/site\.js" defer><\/script>/, 'precondition: site.js is deferred');
  const live = loadLive();
  assert.equal(typeof live.start, 'function');
});

test('without JavaScript the page says the check needs it', () => {
  const ns = page.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? '';
  assert.match(text(ns), /^The check and this preview need JavaScript\./);
});

test('a pasted transaction goes to the live check, and the preview picker only shows samples', () => {
  assert.match(site, /function run\(\{ focus = true \} = \{\}\) \{\n {4}if \(lastQuery\) \{ checkLive\(focus\); return; \}/, 'run() no longer sends a pasted hash to the live check');
  assert.match(site, /window\.AttessaLive\.start\(lastQuery, \{/);
  assert.match(site, /preview\.addEventListener\('change', \(\) => \{ lastQuery = null; show\(preview\.value\); \}\);/, 'the picker could show a sample under a pasted hash');
  assert.match(site, /function show\(key, \{ focus = false \} = \{\}\) \{\n {4}clearTimeout\(timer\);\n {4}window\.AttessaLive\?\.cancel\(\);/, 'a sample could be overwritten by a late live answer');
  // The rows the live result shows as planned are the settled sample's own, unchanged.
  assert.match(site, /rows: STATES\.settled\.rows\.slice\(0, 4\), settled: STATES\.settled/);
});

test('the UI preview stays marked as a preview, and its results stay headed as samples', () => {
  assert.match(page, /<span class="preview-k">UI preview<\/span>Sample states, not a check of any transaction/);
  assert.match(site, /head\('Sample checklist'/);
  assert.match(explorerJs, /r\.heading\('Checklist'\)/);
  assert.match(explorerJs, /'data-live': ''/);
  assert.match(explorerJs, /`read from Celo at \$\{formatTime\(readAt\)\.slice\(11\)\}`/);
});

test('the network switch stays Sepolia only', () => {
  assert.match(layout, /<input type="radio" name="network" value="mainnet" disabled> Celo mainnet <span class="muted">After launch<\/span>/);
  assert.deepEqual(Object.keys(loadLive().NETWORKS), ['sepolia']);
});
