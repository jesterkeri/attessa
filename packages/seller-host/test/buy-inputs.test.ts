import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BuyPaidSource, CAPABILITY_ID, MAX_AMOUNT_CEILING_ATOMIC, PAY_ASSET, atomicToDecimal, loadAgentAccount } from '../src/buy.ts';
import { parseConfig } from '../src/config.ts';
import { BuySpendGuard } from '../src/guard.ts';
import { HttpRpcSource, InputFetcher } from '../src/inputs.ts';
import { FakeRpc } from './fake-rpc.ts';
import { FakeX402, USDC } from './fake-x402.ts';

// TEST DOUBLES: a local x402 v2 seller (fake-x402.ts) and a throwaway key generated here. No real gateway, wallet or payment,
// and the capability id, URL and price below are placeholders, not the real capability (T27 is not done).
const PAY_TO = '0x2222222222222222222222222222222222222222';
const KEY = generatePrivateKey();
const ACCOUNT = privateKeyToAccount(KEY);
const CFG = { capabilityId: 'test-capability', url: 'https://buy.example.test/rpc', maxAmountAtomic: 10_000n };
const NOW = new Date('2026-11-10T12:00:00Z');
const CALLS = [{ method: 'eth_blockNumber', params: [] as unknown[] }];

let forno: FakeRpc;
let x: FakeX402;
let BASE: FakeX402['offers'][0];
beforeEach(async () => {
  forno = new FakeRpc();
  x = new FakeX402();
  await forno.start();
  await x.start();
  BASE = x.offers[0]!;
  for (const r of [forno, x.rpc]) r.accounts.set(PAY_TO, { code: '0x6001', nonce: 1n, balance: 5n });
});
afterEach(async () => {
  await forno.stop();
  await x.stop();
});

function fetcher(paidMode: FakeX402['paidMode'] = 'ok', revenue = 0n, cfg = CFG, fetchImpl: typeof fetch = x.fetchImpl) {
  x.paidMode = paidMode;
  const logs: Array<[string, unknown]> = [];
  const buy = new BuyPaidSource(cfg, ACCOUNT, fetchImpl);
  const guard = new BuySpendGuard(join(mkdtempSync(join(tmpdir(), 'attessa-buy-')), 'g.json'), { settledSince: () => revenue });
  const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy, guard, timeoutMs: 1000, log: (e, d) => logs.push([e, d]) });
  return { f, guard, logs, buy };
}

/** An account whose signer is counted: nothing may be signed for a refused 402. */
function countingAccount(onSign?: () => void) {
  const state = { signs: 0 };
  const account = {
    ...ACCOUNT,
    signTypedData: async (...a: Parameters<typeof ACCOUNT.signTypedData>) => {
      state.signs += 1;
      const sig = await ACCOUNT.signTypedData(...a);
      onSign?.();
      return sig;
    },
  } as typeof ACCOUNT;
  return { account, state };
}

describe('buy inputs (T28)', () => {
  it('inputs: reads through buy as one paid batch of the four reads and records source buy:<id>', async () => {
    const { f, guard } = fetcher('ok');
    const i = await f.fetch(PAY_TO, NOW);
    expect(i.source).toBe('buy:test-capability');
    expect(x.payments).toHaveLength(1);
    expect(x.verified).toEqual([ACCOUNT.address]);
    const paidBody = x.rpc.requests.at(-1) as Array<{ method: string }>;
    expect(paidBody.map((c) => c.method)).toEqual(['eth_getBlockByNumber', 'eth_getCode', 'eth_getTransactionCount', 'eth_getBalance']);
    expect(i.payTo).toMatchObject({ code: '0x6001', nonce: '1', balanceWei: '5' });
    expect(guard.state(NOW).spentAtomic).toBe('10000');
  });

  it('inputs: signs a USDC authorization on chain 42220 for the quoted price only, and the key is nowhere on the wire', async () => {
    const { f } = fetcher('ok');
    await f.fetch(PAY_TO, NOW);
    const p = x.payments[0]!;
    expect(p.payload.authorization).toMatchObject({ from: ACCOUNT.address, value: '10000' });
    expect(p.accepted).toMatchObject({ asset: USDC, network: 'eip155:42220' });
    expect(JSON.stringify(x.payments)).not.toContain(KEY.slice(2));
    expect(x.verified).toHaveLength(1); // the server verified it against chainId 42220 and verifyingContract USDC
  });

  it('inputs: a failed paid read falls back to Forno once, says so, counts the spend, and is never paid again', async () => {
    const { f, logs, guard } = fetcher('http500');
    const i = await f.fetch(PAY_TO, NOW);
    expect(i.source).toBe('forno');
    expect(x.payments).toHaveLength(1);
    expect(logs.map(([e]) => e)).toContain('inputs_primary_failed');
    expect(JSON.stringify(logs)).not.toContain(KEY.slice(2));
    expect(guard.state(NOW).spentAtomic).toBe('10000');
  });

  it.each(['garbage', 'object'] as const)('inputs: a paid reply that fails validation (%s) counts as failed, source is forno', async (mode) => {
    const { f } = fetcher(mode);
    expect((await f.fetch(PAY_TO, NOW)).source).toBe('forno');
    expect(x.payments).toHaveLength(1);
  });

  it('inputs: a paid reply for the wrong block counts as failed, source is forno', async () => {
    x.rpc.mode = 'wrong_block';
    const { f } = fetcher('ok');
    expect((await f.fetch(PAY_TO, NOW)).source).toBe('forno');
    expect(x.payments).toHaveLength(1);
  });

  it('inputs: over the daily budget buy is not called at all', async () => {
    const { f, guard } = fetcher('ok');
    guard.record(995_000n, NOW); // 0 revenue + 1 USDC budget leaves 5,000; a read costs 10,000
    expect((await f.fetch(PAY_TO, NOW)).source).toBe('forno');
    expect(x.unpaid + x.payments.length).toBe(0);
  });

  it('inputs: the per-call maximum is validated: ceiling, positive, https only', () => {
    const ok = (c: Partial<typeof CFG>) => new BuyPaidSource({ ...CFG, ...c }, ACCOUNT);
    expect(() => ok({ maxAmountAtomic: MAX_AMOUNT_CEILING_ATOMIC + 1n })).toThrow(/ceiling/);
    expect(() => ok({ maxAmountAtomic: 0n })).toThrow(/positive/);
    expect(() => ok({ url: 'http://buy.example.test/rpc' })).toThrow(/https/);
    expect(() => ok({ url: 'https://u:p@buy.example.test/rpc' })).toThrow(/credentials/);
    expect(() => ok({ capabilityId: 'has space' })).toThrow(/capabilityId/);
    expect(atomicToDecimal(10_000n)).toBe('0.010000');
    expect(atomicToDecimal(MAX_AMOUNT_CEILING_ATOMIC)).toBe('0.100000');
  });

  describe('config', () => {
    const base = {
      network: 'mainnet',
      registry: '0x' + '1'.repeat(40),
      agentId: '1',
      origin: 'https://attessa.example.com',
      stateDir: '/tmp/s',
      gatewayDbPath: '/tmp/g.db',
      buy: { capabilityId: 'x', url: 'https://buy.example.test/rpc', maxAmount: '0.01' },
    };
    it('inputs: parses a mainnet buy block into atomic units, with no CLI fields', () => {
      const b = parseConfig({ ...base, buy: { ...base.buy, binary: 'buy', account: 'a', home: '/h', keystoreBackend: 'file' } }).buy;
      expect(b).toEqual({ capabilityId: 'x', url: 'https://buy.example.test/rpc', maxAmountAtomic: 10_000n });
    });
    it('inputs: no buy block means Forno only', () => {
      const { buy: _b, ...rest } = base;
      expect(parseConfig(rest).buy).toBeNull();
    });
    it('inputs: refuses paid reads on sepolia and local, without a gateway db, or over the ceiling', () => {
      expect(() => parseConfig({ ...base, network: 'sepolia' })).toThrow(/mainnet only/);
      expect(() => parseConfig({ ...base, network: 'local', chainId: 31337, enclavePort: 1, listen: { port: 2 }, fornoUrl: 'http://127.0.0.1:1' })).toThrow(/mainnet only/);
      expect(() => parseConfig({ ...base, gatewayDbPath: undefined })).toThrow(/gatewayDbPath/);
      expect(() => parseConfig({ ...base, buy: { ...base.buy, maxAmount: '1' } })).toThrow(/ceiling/);
      expect(() => parseConfig({ ...base, buy: { ...base.buy, maxAmount: '0.0000001' } })).toThrow(/decimal/);
    });
  });
});

describe('buy inputs (T28) round 1 behaviours, on the library route', () => {
  it('source: the capability id grammar is the enclave grammar, checked against rules.rs', () => {
    const rules = readFileSync(new URL('../../../enclave/src/rules.rs', import.meta.url), 'utf8');
    expect(rules).toContain('b.is_ascii_alphanumeric() || b".:_/-".contains(&b)');
    for (const id of ['a', 'chainstack/celo-rpc', 'a.b_c:d/e-f', 'A9']) expect(CAPABILITY_ID.test(id), id).toBe(true);
    for (const id of ['', 'a b', 'a+b', 'a@b', 'a,b', "a'b", 'a"b', 'a\\b', 'a%b', 'a\n', 'é', 'a'.repeat(129)]) expect(CAPABILITY_ID.test(id), JSON.stringify(id)).toBe(false);
  });

  it('config: every required buy field is refused at parse time, never becoming buy:undefined', () => {
    const base = { network: 'mainnet', registry: '0x' + '1'.repeat(40), agentId: '1', origin: 'https://attessa.example.com', stateDir: '/tmp/s', gatewayDbPath: '/tmp/g.db' };
    const full = { capabilityId: 'x', url: 'https://buy.example.test/rpc', maxAmount: '0.01' };
    for (const k of ['capabilityId', 'url', 'maxAmount'] as const) {
      const { [k]: _gone, ...rest } = full;
      expect(() => parseConfig({ ...base, buy: rest }), k).toThrow(new RegExp(k));
      expect(() => parseConfig({ ...base, buy: { ...full, [k]: 5 } }), k).toThrow(new RegExp(k));
    }
  });

  it('guard: an unwritable state file falls back to Forno, logs the fault, and makes no paid call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-buy-'));
    writeFileSync(join(dir, 'file'), 'x');
    const guard = new BuySpendGuard(join(dir, 'file', 'sub', 'g.json'), { settledSince: () => 0n }); // ENOTDIR on save
    const logs: string[] = [];
    const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy: new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl), guard, timeoutMs: 1000, log: (e) => logs.push(e) });
    expect((await f.fetch(PAY_TO, NOW)).source).toBe('forno');
    expect(x.unpaid + x.payments.length).toBe(0);
    expect(logs).toContain('buy_guard_fault');
  });

  it('guard: a trip that cannot be written to disk still falls back to Forno', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-buy-'));
    writeFileSync(join(dir, 'file'), 'x');
    const guard = new BuySpendGuard(join(dir, 'file', 'g.json'), { settledSince: () => 0n });
    const buy = new BuyPaidSource({ ...CFG, maxAmountAtomic: 100_000n }, ACCOUNT, x.fetchImpl);
    const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy, guard, timeoutMs: 1000, log: () => {} });
    expect((await f.fetch(PAY_TO, NOW)).source).toBe('forno');
    expect(x.unpaid + x.payments.length).toBe(0);
  });

  it('abort: the timeout ends the in-flight paid request, which is sent once and not retried', async () => {
    x.paidMode = 'hang';
    const src = new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl);
    const t0 = Date.now();
    await expect(src.batch(CALLS, AbortSignal.timeout(300))).rejects.toThrow(/paid read failed \(aborted\)/);
    expect(Date.now() - t0).toBeLessThan(3000);
    await new Promise((r) => setTimeout(r, 400));
    expect(x.payments).toHaveLength(1);
    expect(x.paidClosed).toBe(1); // the server saw the connection end: nothing is left going
    expect(x.unpaid).toBe(1);
  });

  it('abort: aborted while signing, the payment is never sent', async () => {
    const ac = new AbortController();
    const { account, state } = countingAccount(() => ac.abort());
    const src = new BuyPaidSource(CFG, account, x.fetchImpl);
    await expect(src.batch(CALLS, ac.signal)).rejects.toThrow(/paid read failed/);
    expect(state.signs).toBe(1);
    expect(x.payments).toHaveLength(0);
  });

  it('abort: already aborted, nothing is requested at all', async () => {
    const src = new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl);
    await expect(src.batch(CALLS, AbortSignal.abort())).rejects.toThrow(/aborted/);
    expect(x.unpaid + x.payments.length).toBe(0);
  });

  it('pay once: a 5xx, a second 402 after payment, or a dropped connection never makes a second payment', async () => {
    for (const mode of ['http500', 'garbage'] as const) {
      x.paidMode = mode;
      await new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl).batch(CALLS, AbortSignal.timeout(1000)).catch(() => {});
    }
    expect(x.payments).toHaveLength(2); // one per call, none repeated
    const before = x.payments.length;
    let n = 0;
    const flaky: typeof fetch = (u, o) => (new Headers(o?.headers).has('payment-signature') && n++ === 0 ? Promise.reject(new Error('socket hang up')) : x.fetchImpl(u, o));
    await expect(new BuyPaidSource(CFG, ACCOUNT, flaky).batch(CALLS, AbortSignal.timeout(1000))).rejects.toThrow(/paid read failed/);
    expect(n).toBe(1);
    expect(x.payments).toHaveLength(before);
  });

  it('cross-check: a paid block with the right number and a wrong hash or timestamp is a failed paid read', async () => {
    for (const tamper of ['hash', 'timestamp'] as const) {
      const tampering: typeof fetch = async (u, o) => {
        const res = await x.fetchImpl(u, o);
        if (!new Headers(o?.headers).has('payment-signature')) return res;
        const arr = JSON.parse(await res.text()) as Array<{ id: number; result: Record<string, string> }>;
        const blk = arr.find((r) => r.id === 1)!.result;
        if (tamper === 'hash') blk.hash = '0x' + 'ab'.repeat(32);
        else blk.timestamp = '0x1';
        return new Response(JSON.stringify(arr), { status: 200 });
      };
      const { f, logs } = fetcher('ok', 0n, CFG, tampering);
      const i = await f.fetch(PAY_TO, NOW);
      expect(i.source, tamper).toBe('forno');
      expect(i.block.hash).toBe(forno.blockHash(BigInt(i.block.number)));
      expect(JSON.stringify(logs)).toContain('differs from Forno');
    }
  });

  it('cross-check: an honest paid block is checked against Forno at the same number, and Forno failing then does not fail the read', async () => {
    const { f, guard } = fetcher('ok');
    const i = await f.fetch(PAY_TO, NOW);
    expect(i.source).toBe('buy:test-capability');
    expect(forno.requests).toHaveLength(2);
    expect((forno.requests[1] as Array<{ method: string; params: string[] }>)[0]).toMatchObject({ method: 'eth_getBlockByNumber', params: ['0x3e7', false] });
    expect(guard.state(NOW).spentAtomic).toBe('10000');
    // Forno answers the head, then dies for the cross-check: the paid read stands.
    const logs: string[] = [];
    let n = 0;
    const flaky = new HttpRpcSource('forno', forno.url, (async (u: string, o: RequestInit) => (n++ === 0 ? fetch(u, o) : Promise.reject(new Error('down')))) as typeof fetch);
    const g2 = new BuySpendGuard(join(mkdtempSync(join(tmpdir(), 'attessa-buy-')), 'g.json'), { settledSince: () => 0n });
    const f2 = new InputFetcher({ forno: flaky, buy: new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl), guard: g2, timeoutMs: 1000, log: (e) => logs.push(e) });
    expect((await f2.fetch(PAY_TO, NOW)).source).toBe('buy:test-capability');
    expect(logs).toContain('inputs_crosscheck_unavailable');
  });

  it('head: Forno down and buy up, the head is a second counted paid request and buy alone serves the evaluate', async () => {
    forno.mode = 'http500';
    const { f, guard } = fetcher('ok');
    const i = await f.fetch(PAY_TO, NOW);
    expect(i.source).toBe('buy:test-capability');
    expect(x.payments).toHaveLength(2);
    expect((x.rpc.requests[0] as Array<{ method: string }>)[0]).toMatchObject({ method: 'eth_blockNumber' });
    expect(guard.state(NOW).spentAtomic).toBe('20000');
  });

  it('head: the extra paid head request stays inside the budget, and with the budget used up nothing is counted for a call not made', async () => {
    forno.mode = 'http500';
    const { f, guard } = fetcher('ok');
    guard.record(990_000n, NOW);
    await expect(f.fetch(PAY_TO, NOW)).rejects.toThrow(/inputs_unavailable/);
    expect(x.payments).toHaveLength(1);
    expect(guard.state(NOW).spentAtomic).toBe('1000000');
  });

  it('head: when the paid call never happens (budget gone) nothing is counted', async () => {
    forno.mode = 'http500';
    const { f, guard } = fetcher('ok');
    guard.record(995_000n, NOW);
    await expect(f.fetch(PAY_TO, NOW)).rejects.toThrow(/inputs_unavailable/);
    expect(x.unpaid + x.payments.length).toBe(0);
    expect(guard.state(NOW).spentAtomic).toBe('995000');
  });
});

describe('buy inputs (T28) payment limits, enforced before signing', () => {
  async function refused(offers: Array<Partial<(typeof x.offers)[0]>>, cfg = CFG) {
    x.offers = offers.map((o) => ({ ...BASE, ...o }));
    const { account, state } = countingAccount();
    await expect(new BuyPaidSource(cfg, account, x.fetchImpl).batch(CALLS, AbortSignal.timeout(1000))).rejects.toThrow(/paid read failed/);
    expect(state.signs).toBe(0);
    expect(x.payments).toHaveLength(0);
  }

  it('cap: a price above maxAmount is refused before signing; exactly the cap is paid', async () => {
    await refused([{ amount: '10001' }]);
    await refused([{ amount: '99999999999999999999' }]);
    x.offers = [{ ...BASE, amount: '10000' }];
    await new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl).batch(CALLS, AbortSignal.timeout(1000));
    expect(x.payments).toHaveLength(1);
    expect(x.payments[0]!.payload.authorization.value).toBe('10000');
  });

  it('cap: a price that is not a plain non-negative integer is refused before signing', async () => {
    for (const amount of ['-1', '1e3', '0x10', '1.5', ' 5', '', 'abc']) await refused([{ amount }]);
  });

  it('chain: an offer on another chain (mainnet Ethereum, Sepolia) is never signed', async () => {
    await refused([{ network: 'eip155:1' }]);
    await refused([{ network: 'eip155:11142220' }]);
  });

  it('asset: only Celo USDC is paid; another token, or scheme upto, is refused before signing', async () => {
    expect(PAY_ASSET).toBe('0xcebA9300f2b948710d2653dD7B07f33A8B32118C');
    await refused([{ asset: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' }]); // Celo USDT
    await refused([{ asset: '0x' + '9'.repeat(40) }]);
    await refused([{ scheme: 'upto' }]);
    await refused([{ payTo: 'not-an-address' }]);
  });

  it('asset: with a cheaper wrong-token offer listed first, the USDC offer is the one paid', async () => {
    x.offers = [{ ...BASE, asset: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', amount: '1' }, { ...BASE, amount: '9000' }];
    await new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl).batch(CALLS, AbortSignal.timeout(1000));
    expect(x.payments[0]!.payload.authorization.value).toBe('9000');
    expect(x.payments[0]!.accepted.asset).toBe(USDC);
  });

  it('redirect: a paid request that is redirected is not followed, so the payment goes to one origin only', async () => {
    x.paidMode = 'redirect';
    await expect(new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl).batch(CALLS, AbortSignal.timeout(1000))).rejects.toThrow(/paid read failed/);
    expect(x.redirectHits).toBe(0);
    expect(x.payments).toHaveLength(1);
  });

  it('cap: a fallback read after a refused 402 spends nothing and records source forno', async () => {
    x.offers = [{ ...BASE, amount: '10001' }];
    const { f } = fetcher('ok');
    expect((await f.fetch(PAY_TO, NOW)).source).toBe('forno');
    expect(x.payments).toHaveLength(0);
  });
});

describe('buy inputs (T28) the agent key', () => {
  it('key: loads from env only, with or without 0x, in memory', () => {
    const k = loadAgentAccount({ AGENT_PRIVATE_KEY: KEY });
    expect(k.ok && k.account.address).toBe(ACCOUNT.address);
    const bare = loadAgentAccount({ AGENT_PRIVATE_KEY: `${KEY.slice(2)}\n` });
    expect(bare.ok && bare.account.address).toBe(ACCOUNT.address);
  });

  it('key: unset, empty or malformed disables buy with a reason that does not echo the value', () => {
    const bad = ['', '   ', 'not-a-key', '0x1234', KEY + '00', KEY.slice(0, -1), '0x' + 'zz'.repeat(32), '0x' + '00'.repeat(32), '0x' + 'ff'.repeat(32)];
    expect(loadAgentAccount({})).toEqual({ ok: false, reason: 'AGENT_PRIVATE_KEY is not set' });
    for (const v of bad) {
      const r = loadAgentAccount({ AGENT_PRIVATE_KEY: v });
      expect(r.ok, v).toBe(false);
      if (!r.ok) {
        expect(r.reason).toMatch(/^AGENT_PRIVATE_KEY is /);
        if (v.trim().length > 6) expect(r.reason).not.toContain(v.trim());
      }
    }
  });

  it('key: a failure that carries the key in its own message does not reach the thrown error, and the source does not serialise it', async () => {
    const leaking: typeof fetch = () => Promise.reject(new Error(`connect failed, key ${KEY}`));
    const src = new BuyPaidSource(CFG, ACCOUNT, leaking);
    const e = (await src.batch(CALLS, AbortSignal.timeout(1000)).then(() => null, (err: Error) => err))!;
    expect(e.message).toBe('buy:test-capability: paid read failed (error)');
    expect(JSON.stringify([e.message, e.stack, e.cause])).not.toContain(KEY.slice(2));
    expect(JSON.stringify(src)).not.toContain(KEY.slice(2));
    expect(inspect(src, { depth: 6 })).not.toContain(KEY.slice(2));
  });

  it('key: nothing in the fallback logs, the source id or the config echo reaches the key', async () => {
    const { f, logs } = fetcher('http500');
    await f.fetch(PAY_TO, NOW);
    expect(JSON.stringify(logs)).not.toContain(KEY.slice(2));
    expect(JSON.stringify(parseConfig({ network: 'mainnet', registry: '0x' + '1'.repeat(40), agentId: '1', origin: 'https://attessa.example.com', stateDir: '/tmp/s', gatewayDbPath: '/tmp/g.db', buy: { capabilityId: 'x', url: 'https://buy.example.test/rpc', maxAmount: '0.01' } }), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(KEY.slice(2));
  });
});
