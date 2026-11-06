// The live payment check's error paths: Celo unreachable, too slow, an RPC error, the wrong chain, and answers
// that are not what they claim. Run from the repo root: node --test packages/site/test/explorer-live-errors.test.mjs
//
// HAND-WRITTEN ANSWERS: everything here except the base receipt is written by hand on purpose, because these
// are transport failures and malformed answers a real RPC rarely gives on demand. Each malformed receipt is
// the real recorded one (fixtures/sepolia-x402settled.json) with one field broken, and says which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLive, fixture, scripted, replay, makeUi, words } from './lib/live.mjs';

const live = loadLive();
const net = live.NETWORKS.sepolia;
const HASH = `0x${'ab'.repeat(32)}`;
const ok = result => req => ({ jsonrpc: '2.0', id: req.id, result });
const CHAIN = `0x${net.chainId.toString(16)}`;
const rpcHost = 'forno.celo-sepolia.celo-testnet.org';
const unreachable = `Can't reach Celo right now The explorer couldn't read Celo Sepolia from its connection to the network (${rpcHost}). Nothing was checked, and nothing about the call itself has changed. Try again in a moment. Retry`;
const shown = o => { const { ui } = makeUi(); live.render(ui, o); return words(ui.result); };

test('fetch rejecting (offline, DNS, CORS) is "Can\'t reach Celo right now" with a Retry', async () => {
  const o = await live.check(HASH, 'sepolia', { fetch: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(o.kind, 'unreachable');
  assert.equal(shown(o), unreachable);
  const { ui } = makeUi(); live.render(ui, o);
  assert.ok(ui.result.find(e => e.hasAttribute('data-retry')), 'no Retry button (site.js reruns the check on [data-retry])');
});

for (const status of [429, 500, 502]) {
  test(`HTTP ${status} from the RPC is unreachable`, async () => {
    const o = await live.check(HASH, 'sepolia', { fetch: async () => ({ ok: false, status, json: async () => ({}) }) });
    assert.equal(o.kind, 'unreachable');
    assert.equal(shown(o), unreachable);
  });
}

test('an RPC that never answers times out, and the page says so', async () => {
  // Hand-written: a fetch that ignores the abort signal entirely, so only the explorer's own race can end it.
  const t0 = Date.now();
  const o = await live.check(HASH, 'sepolia', { fetch: () => new Promise(() => {}), timeoutMs: 50 });
  assert.equal(o.kind, 'timeout');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(shown(o), `Can't reach Celo right now The explorer couldn't read Celo Sepolia from its connection to the network (${rpcHost}). Nothing was checked, and nothing about the call itself has changed. Try again in a moment. It didn't answer within ${live.TIMEOUT_MS / 1000} seconds. Retry`);
});

test('a fetch that honours the abort signal also times out', async () => {
  const fetch = (url, init) => new Promise((_, no) => init.signal.addEventListener('abort', () => no(new Error('AbortError'))));
  const o = await live.check(HASH, 'sepolia', { fetch, timeoutMs: 30 });
  assert.equal(o.kind, 'timeout');
});

test('a JSON-RPC error object is not a result', async () => {
  const o = await live.check(HASH, 'sepolia', { fetch: scripted(req => ({ jsonrpc: '2.0', id: req.id, error: { code: -32005, message: 'rate limited' } })) });
  assert.equal(o.kind, 'rpcerror');
  assert.equal(shown(o), unreachable);
});

test('an RPC on another chain is refused before its receipt is used', async () => {
  // Hand-written: 0xa4ec is Celo mainnet (42220). The receipt answer is the real one, to show it is not used.
  const real = fixture('x402settled');
  const receipt = real.calls.find(c => c.request.method === 'eth_getTransactionReceipt').response.result;
  const o = await live.check(real.txHash, 'sepolia', { fetch: scripted(req => (req.method === 'eth_chainId' ? ok('0xa4ec')(req) : ok(receipt)(req))) });
  assert.equal(o.kind, 'wrongchain');
  assert.equal(o.got, '42220');
  assert.equal(o.payer, undefined);
  assert.equal(shown(o), `Connected to the wrong network The explorer's connection to the network (${rpcHost}) answered as chain 42220, not Celo Sepolia (chain 11142220), so nothing was checked.`);
});

const notReadable = `Can't read Celo's answer The explorer's connection to the network (${rpcHost}) sent an answer it couldn't read, so nothing was checked. Try again in a moment. Retry`;

test('answers that are not JSON-RPC answers to this request are refused', async () => {
  const cases = {
    'not JSON': () => ({ __response: { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } } }),
    'another request\'s id': req => ({ jsonrpc: '2.0', id: req.id + 1000, result: CHAIN }),
    'no jsonrpc 2.0': req => ({ id: req.id, result: CHAIN }),
    'no result': req => ({ jsonrpc: '2.0', id: req.id }),
    'an array': () => [],
    'a chain id that is not a quantity': req => ({ jsonrpc: '2.0', id: req.id, result: req.method === 'eth_chainId' ? '11142220' : null }),
  };
  for (const [what, fn] of Object.entries(cases)) {
    const o = await live.check(HASH, 'sepolia', { fetch: scripted(fn) });
    assert.equal(o.kind, 'badanswer', `${what}: ${o.kind}`);
    assert.equal(shown(o), notReadable, what);
  }
});

test('malformed receipts (each the real one with one field broken) are refused, never half-shown', async () => {
  const real = fixture('x402settled');
  const at = m => real.calls.find(c => c.request.method === m).response.result;
  const base = at('eth_getTransactionReceipt');
  const block = at('eth_getBlockByNumber');
  const iT = base.logs.findIndex(l => l.address.toLowerCase() === net.tokens[0].address && l.topics[0] === live.TRANSFER);
  const mutate = f => { const r = structuredClone(base); f(r, r.logs[iT]); return r; };
  const cases = {
    'receipt for another transaction': mutate(r => { r.transactionHash = HASH; }),
    'blockNumber not hex': mutate(r => { r.blockNumber = '12345'; }),
    'blockNumber with leading zeros': mutate(r => { r.blockNumber = '0x00ff'; }),
    'status 0x2': mutate(r => { r.status = '0x2'; }),
    'no status': mutate(r => { delete r.status; }),
    'logs not a list': mutate(r => { r.logs = {}; }),
    'a log address with markup': mutate((r, l) => { l.address = '<img src=x onerror=alert(1)>'; }),
    'Transfer with two topics': mutate((r, l) => { l.topics = l.topics.slice(0, 2); }),
    'from topic with markup': mutate((r, l) => { l.topics[1] = `<b>${l.topics[1]}</b>`; }),
    'from topic not an address word': mutate((r, l) => { l.topics[1] = `0x${'f'.repeat(64)}`; }),
    'amount two words': mutate((r, l) => { l.data = `${l.data}${'0'.repeat(64)}`; }),
    'amount short': mutate((r, l) => { l.data = '0x01'; }),
    'log from another transaction': mutate((r, l) => { l.transactionHash = HASH; }),
    'no block hash': mutate(r => { delete r.blockHash; }),
  };
  for (const [what, receipt] of Object.entries(cases)) {
    const fetch = scripted(req => ok(req.method === 'eth_chainId' ? CHAIN : req.method === 'eth_getTransactionReceipt' ? receipt : block)(req));
    const o = await live.check(real.txHash, 'sepolia', { fetch });
    assert.equal(o.kind, 'badanswer', `${what}: ${o.kind}`);
    assert.equal(o.payer, undefined, what);
    assert.equal(shown(o), notReadable, what);
  }
});

test('a block that is not the receipt\'s block is refused (each the real one with one field broken)', async () => {
  const real = fixture('x402settled');
  const at = m => real.calls.find(c => c.request.method === m).response.result;
  const receipt = at('eth_getTransactionReceipt');
  const base = at('eth_getBlockByNumber');
  const cases = {
    'missing block': null,
    'another block hash': { ...base, hash: `0x${'cd'.repeat(32)}` },
    'another number': { ...base, number: `0x${(BigInt(base.number) + 1n).toString(16)}` },
    'timestamp not hex': { ...base, timestamp: 'yesterday' },
  };
  for (const [what, block] of Object.entries(cases)) {
    const fetch = scripted(req => ok(req.method === 'eth_chainId' ? CHAIN : req.method === 'eth_getTransactionReceipt' ? receipt : block)(req));
    const o = await live.check(real.txHash, 'sepolia', { fetch });
    assert.equal(o.kind, 'badanswer', `${what}: ${o.kind}`);
  }
});

test('a removed (reorged-out) log is not counted as a payment', async () => {
  const real = fixture('x402settled');
  const receipt = structuredClone(real.calls.find(c => c.request.method === 'eth_getTransactionReceipt').response.result);
  for (const l of receipt.logs) l.removed = true; // hand-written: the real receipt with every log marked removed
  const fetch = scripted(req => ok(req.method === 'eth_chainId' ? CHAIN : receipt)(req));
  assert.equal((await live.check(real.txHash, 'sepolia', { fetch })).kind, 'notransfer');
});

test('a malformed hash and an unknown network never reach the network', async () => {
  const log = [];
  const fetch = scripted(() => { throw new Error('should not be called'); }, { log });
  for (const h of ['', '0x', `0x${'g'.repeat(64)}`, `0x${'a'.repeat(63)}`, `0x${'a'.repeat(65)}`, `${'a'.repeat(64)}`, `0x${'a'.repeat(64)}<`]) {
    assert.equal((await live.check(h, 'sepolia', { fetch })).kind, 'malformed', h);
  }
  const m = await live.check(HASH, 'mainnet', { fetch });
  assert.equal(m.kind, 'unsupported', 'mainnet must stay off until Gate 5');
  assert.equal(log.length, 0);
  assert.equal(shown(await live.check('0x', 'sepolia', { fetch })), "That isn't a transaction hash A settlement transaction starts with 0x and has 64 hex characters after it (0 to 9, a to f).");
  assert.equal(shown(m), 'Not on this network yet The live check reads Celo Sepolia only. Celo mainnet comes after launch.');
  assert.deepEqual(Object.keys(live.NETWORKS), ['sepolia']);
});

test('an upper-case pasted hash is checked as its lower-case form', async () => {
  const real = fixture('x402settled');
  const o = await live.check(real.txHash.toUpperCase().replace('0X', '0x'), 'sepolia', { fetch: replay(real.calls) });
  assert.equal(o.kind, 'settled');
});

test('a second check cancels the first, and the late answer is dropped', async () => {
  const real = fixture('x402settled');
  let release;
  const gate = new Promise(r => { release = r; });
  const slow = scripted(async req => { await gate; return ok(CHAIN)(req); });
  const { ui } = makeUi({ fetch: slow, timeoutMs: 5000 });
  const first = live.start(HASH, ui);
  assert.match(words(ui.result), /^Checking the payment on Celo Settlement tx 0xabab…abab on Celo Sepolia /);
  assert.ok(words(ui.result).endsWith('Checking Payment Reading this transaction from Celo Sepolia.'));
  assert.equal(ui.result.getAttribute('aria-busy'), 'true');
  ui.fetch = replay(real.calls);
  const second = await live.start(real.txHash, ui);
  release();
  const firstOut = await first;
  assert.equal(second.kind, 'settled');
  assert.equal(firstOut.kind, 'cancelled');
  assert.match(words(ui.result), /^Checklist /, 'the cancelled check overwrote the newer result');
  assert.equal(ui.result.hasAttribute('aria-busy'), false);
});

test('cancel() (the preview picker) stops a running check from drawing over the sample', async () => {
  const { ui } = makeUi({ fetch: () => new Promise(() => {}), timeoutMs: 5000 });
  const p = live.start(HASH, ui);
  live.cancel();
  ui.result.replaceChildren('sample');
  assert.equal((await p).kind, 'cancelled');
  assert.equal(words(ui.result), 'sample');
});

test('amounts use the token\'s decimals exactly, with no rounding', () => {
  const f = live.formatAmount;
  assert.equal(f(0n, 6), '0');
  assert.equal(f(1n, 6), '0.000001');
  assert.equal(f(10000n, 6), '0.01');
  assert.equal(f(1234500n, 6), '1.2345');
  assert.equal(f(1234567890123n, 6), '1,234,567.890123');
  assert.equal(f(2n ** 256n - 1n, 6).replace(/,/g, '').length, 79);
  assert.equal(live.formatTime(new Date(1730800000 * 1000)), '2024-11-05 09:46:40 UTC');
});
