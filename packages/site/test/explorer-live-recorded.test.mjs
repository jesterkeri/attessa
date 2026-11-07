// The explorer's live payment check (assets/explorer.js) against answers recorded from the real Celo Sepolia
// RPC (packages/site/test/fixtures/sepolia-*.json, written by packages/site/test/fixtures/capture.mjs; each file says when).
// Run from the repo root: node --test packages/site/test/explorer-live-recorded.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLive, fixture, replay, makeUi, words, src } from './lib/live.mjs';

const live = loadLive();
const net = live.NETWORKS.sepolia;
const run = async (name, log = []) => {
  const f = fixture(name);
  return { f, o: await live.check(f.txHash, 'sepolia', { fetch: replay(f.calls, { log }) }) };
};
const word = n => BigInt(n);

test('explorer.js pins the Sepolia network the CLI and core use', () => {
  const ctx = readFileSync(join(src, '..', '..', '..', 'packages', 'cli', 'src', 'context.ts'), 'utf8');
  const dep = readFileSync(join(src, '..', '..', '..', 'packages', 'core', 'src', 'deployments.ts'), 'utf8');
  assert.equal(net.chainId, 11142220);
  assert.match(ctx, new RegExp(`sepolia: '${net.rpc.replace(/\./g, '\\.')}'`), 'RPC is not the CLI default');
  const sepolia = dep.match(/'celo-sepolia': \{[\s\S]*?\n {2}\},/)?.[0] ?? '';
  assert.match(sepolia, /chainId: 11142220/);
  const pinned = [...sepolia.matchAll(/(\w+): \{ address: '(0x[0-9a-fA-F]{40})'/g)].map(m => m[2].toLowerCase());
  assert.deepEqual([...net.tokens.map(t => t.address)], pinned, 'explorer.js tokens differ from deployments.ts celo-sepolia assets');
});

test('the pinned decimals and symbol match the token on Celo Sepolia', () => {
  const t = fixture('usdc-token');
  assert.equal(t.address, net.tokens[0].address);
  const [dec, sym] = t.calls.map(c => c.response.result);
  assert.equal(Number(BigInt(dec)), net.tokens[0].decimals);
  // ABI string: offset, length, bytes.
  const len = Number(BigInt(`0x${sym.slice(66, 130)}`));
  assert.equal(Buffer.from(sym.slice(130, 130 + len * 2), 'hex').toString('utf8'), net.tokens[0].symbol);
});

test('a real USDC transfer: payer, paid address, amount, block and time come from the receipt and block', async () => {
  const log = [];
  const { f, o } = await run('x402settled', log);
  assert.equal(o.kind, 'settled', JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const receipt = f.calls.find(c => c.request.method === 'eth_getTransactionReceipt').response.result;
  const block = f.calls.find(c => c.request.method === 'eth_getBlockByNumber').response.result;
  const t = receipt.logs.filter(l => l.address.toLowerCase() === net.tokens[0].address && l.topics[0] === live.TRANSFER);
  assert.equal(t.length, 1, 'precondition: the recorded receipt has one USDC Transfer');
  assert.equal(o.hash, f.txHash.toLowerCase());
  assert.equal(o.payer, `0x${t[0].topics[1].slice(26)}`.toLowerCase());
  assert.equal(o.payTo, `0x${t[0].topics[2].slice(26)}`.toLowerCase());
  assert.equal(o.amount, word(t[0].data));
  assert.equal(o.blockNumber, word(receipt.blockNumber));
  assert.equal(o.time.getTime(), Number(word(block.timestamp)) * 1000);
  assert.equal(o.token.symbol, 'USDC');
  // Exactly the three reads, all to the pinned RPC, all POST, no cookies.
  assert.deepEqual(log.map(l => l.method).sort(), ['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionReceipt']);
  assert.ok(log.every(l => l.url === net.rpc && l.init.method === 'POST' && l.init.credentials === 'omit'));
});

test('the settled result renders the recorded values, the four planned rows and a Blockscout link', async () => {
  const { f, o } = await run('x402settled');
  const { ui, doc, said, verdicts } = makeUi();
  live.render(ui, o, { readAt: new Date('2026-11-05T10:00:00Z') });
  const text = words(ui.result);
  const amount = `${live.formatAmount(o.amount, 6)} USDC`;
  assert.match(text, /^Checklist Settlement tx 0x[0-9a-f]{4}…[0-9a-f]{4} on Celo Sepolia read from Celo at 10:00:00 UTC Settled on Celo /);
  for (const n of ui.names.slice(0, 4)) assert.ok(text.includes(`Planned ${n}`), `row ${n} not Planned`);
  assert.ok(text.includes(`Paid Payment ${o.payer.slice(0, 6)}…${o.payer.slice(-4)} paid ${amount} to ${o.payTo.slice(0, 6)}…${o.payTo.slice(-4)} at block ${o.blockNumber}.`), text);
  assert.ok(text.includes(`block time ${live.formatTime(o.time)}, USDC contract 0x01c5…c44e`), text);
  assert.ok(text.includes('See it on Blockscout (opens in a new tab)'));
  assert.ok(text.endsWith(`Overall verdict ${ui.settled.verdictLine}`));
  const a = ui.result.find(e => e.tagName === 'a');
  assert.equal(a.getAttribute('href'), `https://celo-sepolia.blockscout.com/tx/${f.txHash.toLowerCase()}`);
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  // Full values sit on the chips for expand and copy (site.js's click handler).
  const full = ui.result.all(e => e.hasAttribute('data-full')).map(e => e.getAttribute('data-full'));
  assert.deepEqual(full, [o.hash, o.payer, o.payTo, net.tokens[0].address]);
  assert.equal(doc.activeElement?.tagName, 'h2', 'focus did not move to the result heading');
  assert.equal(doc.activeElement.textContent, 'Checklist');
  assert.deepEqual(verdicts, ['settled']);
  assert.deepEqual(said, [`Settled on Celo. ${amount} paid at block ${o.blockNumber}.`]);
  assert.equal(ui.result.hasAttribute('aria-busy'), false);
});

test('a hash with no transaction is "No call found"', async () => {
  const { f, o } = await run('notfound');
  assert.equal(f.calls[1].response.result, null, 'precondition: recorded receipt is not null');
  assert.equal(o.kind, 'notfound');
  const { ui } = makeUi();
  live.render(ui, o);
  assert.equal(words(ui.result), `No call found Nothing on Celo Sepolia matches ${o.hash.slice(0, 6)}…${o.hash.slice(-4)}. If the call was made in the last few seconds, its transaction may not be in a block yet. Check that the network in the footer is the one the call used.`);
});

test('a real reverted transaction is refused, with its block', async () => {
  const { f, o } = await run('reverted');
  const receipt = f.calls[1].response.result;
  assert.equal(receipt.status, '0x0', 'precondition: recorded receipt did not revert');
  assert.equal(o.kind, 'reverted');
  assert.equal(o.blockNumber, word(receipt.blockNumber));
  const { ui } = makeUi();
  live.render(ui, o);
  assert.equal(words(ui.result), `This transaction failed ${o.hash.slice(0, 6)}…${o.hash.slice(-4)} is in block ${o.blockNumber} on Celo Sepolia, but it reverted, so it moved no money and isn't a settlement. See it on Blockscout (opens in a new tab)`);
});

test('a real transaction that moves no pinned token is not a settlement', async () => {
  const { f, o } = await run('notransfer');
  const receipt = f.calls[1].response.result;
  assert.equal(receipt.status, '0x1', 'precondition');
  assert.equal(o.kind, 'notransfer');
  const { ui } = makeUi();
  live.render(ui, o);
  assert.equal(words(ui.result), `No payment in this transaction ${o.hash.slice(0, 6)}…${o.hash.slice(-4)} is in block ${o.blockNumber} on Celo Sepolia, but it moves no USDC, the money Attessa settles in on this network, so it isn't a settlement. See it on Blockscout (opens in a new tab)`);
});

test('a real transaction with more than one USDC transfer is refused, not guessed', async () => {
  const { f, o } = await run('multiple');
  const n = f.calls[1].response.result.logs.filter(l => l.address.toLowerCase() === net.tokens[0].address && l.topics[0] === live.TRANSFER).length;
  assert.ok(n > 1, 'precondition');
  assert.equal(o.kind, 'multiple');
  assert.equal(o.count, n);
  assert.equal(o.payer, undefined, 'a refused result carries no payer');
  const { ui } = makeUi();
  live.render(ui, o);
  assert.equal(words(ui.result), `More than one payment in this transaction ${o.hash.slice(0, 6)}…${o.hash.slice(-4)} moves USDC ${n} times, in block ${o.blockNumber} on Celo Sepolia. A settlement moves it once, so the explorer doesn't pick one and shows none of them. See it on Blockscout (opens in a new tab)`);
});

// ---- Codex site-finish r1 M1: a plain USDC transfer is not an x402 settlement (SPEC.md section 6.2 V11) ----
// V11: the same transaction holds the pinned token's AuthorizationUsed(authorizer, nonce) and the matching Transfer from that
// address. Only then may the explorer say an x402 payment settled; a Transfer alone is a plain transfer.
const AUTH_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
const without = (f, keep) => ({ ...f, calls: f.calls.map(c => (c.request.method === 'eth_getTransactionReceipt' && c.response.result
  ? { ...c, response: { ...c.response, result: { ...c.response.result, logs: c.response.result.logs.filter(keep) } } } : c)) });
const outcome = async f => live.check(f.txHash, 'sepolia', { fetch: replay(f.calls) });

test('the recorded x402 settlement really holds AuthorizationUsed and one Transfer from the same address (precondition)', () => {
  const f = fixture('x402settled');
  const logs = f.calls[1].response.result.logs.filter(l => l.address.toLowerCase() === net.tokens[0].address);
  const auth = logs.filter(l => l.topics[0] === AUTH_USED), tr = logs.filter(l => l.topics[0] === live.TRANSFER);
  assert.equal(auth.length, 1);
  assert.equal(tr.length, 1);
  assert.equal(auth[0].topics[1], tr[0].topics[1]);
});

test('a real plain USDC transfer is "a plain USDC transfer, not an x402 settlement", never a settlement', async () => {
  const f = fixture('plaintransfer');
  const logs = f.calls[1].response.result.logs;
  assert.equal(logs.filter(l => l.topics[0] === AUTH_USED).length, 0, 'precondition: the recording has no AuthorizationUsed');
  assert.equal(logs.filter(l => l.address.toLowerCase() === net.tokens[0].address && l.topics[0] === live.TRANSFER).length, 1, 'precondition');
  const o = await outcome(f);
  assert.equal(o.kind, 'plaintransfer');
  const { ui, said, verdicts } = makeUi();
  live.render(ui, o);
  const text = words(ui.result);
  assert.match(text, /^A plain USDC transfer, not an x402 settlement /);
  assert.ok(text.includes(`${o.payer.slice(0, 6)}…${o.payer.slice(-4)} sent`), text);
  assert.doesNotMatch(text, /Settled on Celo|Settlement tx|Checklist|Overall verdict|Paid Payment/);
  assert.match(text, /no x402 authorization/i);
  assert.deepEqual(verdicts, ['idle']);
  assert.ok(said.every(s => !/settled/i.test(s) || /not an x402 settlement/.test(s)), said.join('|'));
});

test('a settlement with its AuthorizationUsed removed, or from another address or contract, is a plain transfer', async () => {
  const real = fixture('x402settled');
  assert.equal((await outcome(real)).kind, 'settled');
  const noAuth = await outcome(without(real, l => l.topics[0] !== AUTH_USED));
  assert.equal(noAuth.kind, 'plaintransfer');
  const otherPayer = JSON.parse(JSON.stringify(real));
  const rec = otherPayer.calls[1].response.result.logs.find(l => l.topics[0] === AUTH_USED);
  rec.topics[1] = `0x${'0'.repeat(24)}${'ab'.repeat(20)}`;
  assert.equal((await outcome(otherPayer)).kind, 'plaintransfer', 'an authorization by someone else does not make this transfer an x402 payment');
  const otherToken = JSON.parse(JSON.stringify(real));
  otherToken.calls[1].response.result.logs.find(l => l.topics[0] === AUTH_USED).address = `0x${'cd'.repeat(20)}`;
  assert.equal((await outcome(otherToken)).kind, 'plaintransfer', 'AuthorizationUsed from another contract does not count');
});

test('the x402 settlement result says an x402 payment settled and that the link to a call and its proof is not shown', async () => {
  const o = await outcome(fixture('x402settled'));
  const { ui } = makeUi();
  live.render(ui, o);
  const text = words(ui.result);
  assert.match(text, /x402 payment settled on Celo/);
  assert.match(text, /isn't a verified call/);
  assert.match(text, /which endpoint, build or signer answered/);
  assert.match(text, /needs the call's proof/);
  assert.match(text, /no link to an Attessa call is shown/i);
});
