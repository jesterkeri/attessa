import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BuyPaidSource } from '../src/buy.ts';
import { BuySpendGuard } from '../src/guard.ts';
import { BuyIntentLedger } from '../src/ledger.ts';
import { HttpRpcSource, InputFetcher } from '../src/inputs.ts';
import { FakeRpc } from './fake-rpc.ts';
import { FakeX402 } from './fake-x402.ts';

// Adversary T28 r2 (7de4490). Test doubles only, throwaway key generated here.
const PAY_TO = '0x2222222222222222222222222222222222222222';
const ACCOUNT = privateKeyToAccount(generatePrivateKey());
const CFG = { capabilityId: 'test-capability', url: 'https://buy.example.test/rpc', maxAmountAtomic: 10_000n };
const NOW = new Date();

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

function wire(buyFetch: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'attessa-adv-'));
  const ledger = new BuyIntentLedger(join(dir, 'i.jsonl'));
  const guard = new BuySpendGuard(join(dir, 'g.json'), { settledSince: () => 0n }, () => {}, ledger);
  const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy: new BuyPaidSource(CFG, ACCOUNT, buyFetch, undefined, ledger), guard, timeoutMs: 1000 });
  return { dir, ledger, guard, f };
}

describe('T28 r2 attacks', () => {
  it('a paid reply with the honest block header but forged payTo code, nonce and balance is not handed on as anchored inputs', async () => {
    x.paidMode = 'ok';
    const forging: typeof fetch = async (input, init) => {
      const res = await x.fetchImpl(input, init);
      if (!init?.headers || !new Headers(init.headers).has('payment-signature')) return res;
      const arr = JSON.parse(await res.text()) as Array<{ id: number; result: unknown }>;
      arr.find((r) => r.id === 2)!.result = '0x';
      arr.find((r) => r.id === 3)!.result = '0x0';
      arr.find((r) => r.id === 4)!.result = '0xde0b6b3a7640000';
      return new Response(JSON.stringify(arr), { status: 200 });
    };
    const { f } = wire(forging);
    const i = await f.fetch(PAY_TO, NOW);
    // Whatever the source label, the values for the enclave must equal what Forno holds at that height.
    expect({ code: i.payTo.code, nonce: i.payTo.nonce, balanceWei: i.payTo.balanceWei }).toEqual({ code: '0x6001', nonce: '1', balanceWei: '5' });
  });

  it('double count: after a state-file deletion the next paid call adds exactly one cap to the day total', async () => {
    x.paidMode = 'ok';
    const { dir, ledger, guard, f } = wire(x.fetchImpl);
    await f.fetch(PAY_TO, NOW);
    rmSync(join(dir, 'g.json'));
    await f.fetch(PAY_TO, NOW);
    expect(ledger.read().filter((l) => l.kind === 'intent')).toHaveLength(2);
    expect(guard.state(NOW).spentAtomic).toBe('20000');
  });

  it('torn last line (complete JSON, no newline) then a later append: the ledger must fault, never undercount', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-adv-'));
    const p = join(dir, 'i.jsonl');
    const ledger = new BuyIntentLedger(p);
    const day = NOW.toISOString().slice(0, 10);
    ledger.append({ v: 1, kind: 'intent', id: 'a', cap: '10000', timestamp: NOW.toISOString() });
    appendFileSync(p, JSON.stringify({ v: 1, kind: 'intent', id: 'b', cap: '10000', timestamp: NOW.toISOString() }));
    ledger.append({ v: 1, kind: 'intent', id: 'c', cap: '10000', timestamp: NOW.toISOString() });
    let spent: bigint | 'fault';
    try {
      spent = ledger.spentOn(day);
    } catch {
      spent = 'fault';
    }
    expect(spent === 'fault' || spent === 30000n).toBe(true);
  });
});
