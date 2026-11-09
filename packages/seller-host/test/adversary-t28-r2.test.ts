import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BuyPaidSource } from '../src/buy.ts';
import { BuySpendGuard } from '../src/guard.ts';
import { HttpRpcSource, InputFetcher } from '../src/inputs.ts';
import { FakeRpc } from './fake-rpc.ts';
import { FakeX402 } from './fake-x402.ts';

// Adversary round 2 for T28 (origin/feat/t28-buy-inputs f819bed). Test doubles only, throwaway key generated here.
const PAY_TO = '0x2222222222222222222222222222222222222222';
const ACCOUNT = privateKeyToAccount(generatePrivateKey());
const CFG = { capabilityId: 'test-capability', url: 'https://buy.example.test/rpc', maxAmountAtomic: 10_000n };
const NOW = new Date('2026-11-10T12:00:00Z');

let forno: FakeRpc;
let x: FakeX402;
beforeEach(async () => {
  forno = new FakeRpc();
  x = new FakeX402();
  await forno.start();
  await x.start();
  for (const r of [forno, x.rpc]) r.accounts.set(PAY_TO, { code: '0x6001', nonce: 1n, balance: 5n });
});
afterEach(async () => {
  await forno.stop();
  await x.stop();
});

/** Forno that fails its first request only (one transient fault), then answers normally. */
function flakyOnce(): HttpRpcSource {
  let n = 0;
  return new HttpRpcSource('forno', forno.url, (async (u: string, o: RequestInit) => (n++ === 0 ? Promise.reject(new Error('transient')) : fetch(u, o))) as typeof fetch);
}

function fetcherWith(fornoSrc: HttpRpcSource, fetchImpl: typeof fetch = x.fetchImpl) {
  const buy = new BuyPaidSource(CFG, ACCOUNT, fetchImpl);
  const guard = new BuySpendGuard(join(mkdtempSync(join(tmpdir(), 'attessa-r2-')), 'g.json'), { settledSince: () => 0n });
  return { f: new InputFetcher({ forno: fornoSrc, buy, guard, timeoutMs: 1000 }), guard };
}

describe('T28 adversary r2', () => {
  it('SPEC §5 / FR-11: one transient Forno head failure must not make one evaluate pay twice', async () => {
    const { f } = fetcherWith(flakyOnce());
    await f.fetch(PAY_TO, NOW);
    // "one JSON-RPC batch per evaluate", "an evaluate pays at most once".
    expect(x.payments.length).toBeLessThanOrEqual(1);
  });

  it('chain cross-check: after a transient Forno head failure a paid block with a wrong hash is still rejected (Forno is up for the check)', async () => {
    const lying: typeof fetch = async (u, o) => {
      const res = await x.fetchImpl(u, o);
      if (!new Headers(o?.headers).has('payment-signature')) return res;
      const arr = JSON.parse(await res.text()) as Array<{ id: number; result: unknown }>;
      for (const r of arr) if (typeof r.result === 'object' && r.result !== null && 'hash' in r.result) (r.result as { hash: string }).hash = '0x' + 'ab'.repeat(32);
      return new Response(JSON.stringify(arr), { status: 200 });
    };
    const { f } = fetcherWith(flakyOnce(), lying);
    const i = await f.fetch(PAY_TO, NOW);
    expect(i.block.hash).toBe(forno.blockHash(BigInt(i.block.number)));
  });

  it('the signed authorization is not valid for longer than a bounded window, whatever maxTimeoutSeconds the seller offers', async () => {
    x.offers[0]!.maxTimeoutSeconds = 1_000_000_000; // 31 years, chosen by the seller
    const buy = new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl);
    await expect(buy.batch([{ method: 'eth_blockNumber', params: [] }], new AbortController().signal)).rejects.toThrow(/refused_requirement/);
    expect(x.payments).toHaveLength(0);
    x.offers[0]!.maxTimeoutSeconds = 3600;
    await buy.batch([{ method: 'eth_blockNumber', params: [] }], new AbortController().signal);
    const a = x.payments[0]!.payload.authorization as { validBefore: string };
    expect(Number(a.validBefore) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3600);
  });
});
