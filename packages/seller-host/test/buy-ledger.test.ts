import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BuyPaidSource } from '../src/buy.ts';
import { BuySpendGuard } from '../src/guard.ts';
import { HttpRpcSource, InputFetcher } from '../src/inputs.ts';
import { BuyIntentLedger } from '../src/ledger.ts';
import { FakeRpc } from './fake-rpc.ts';
import { FakeX402 } from './fake-x402.ts';

// TEST DOUBLES only: local fake seller and Forno, throwaway key. No real payment.
const ACCOUNT = privateKeyToAccount(generatePrivateKey());
const CFG = { capabilityId: 'test-capability', url: 'https://buy.example.test/rpc', maxAmountAtomic: 10_000n };
const CALLS = [{ method: 'eth_blockNumber', params: [] as unknown[] }];
const PAY_TO = '0x2222222222222222222222222222222222222222';
const NOW = new Date('2026-11-10T12:00:00Z');

let x: FakeX402;
let forno: FakeRpc;
let dir: string;
beforeEach(async () => {
  x = new FakeX402();
  forno = new FakeRpc();
  await x.start();
  await forno.start();
  for (const r of [forno, x.rpc]) r.accounts.set(PAY_TO, { code: '0x6001', nonce: 1n, balance: 5n });
  dir = mkdtempSync(join(tmpdir(), 'attessa-ledger-'));
});
afterEach(async () => {
  await x.stop();
  await forno.stop();
  rmSync(dir, { recursive: true, force: true });
});

const lines = (l: BuyIntentLedger) => l.read();

describe('M2: a payment on the wire leaves a durable intent', () => {
  it('writes the intent (payer, cap, capability, timestamp) and the nonce before sending, then a responded outcome', async () => {
    const ledger = new BuyIntentLedger(join(dir, 'buy-intents.jsonl'));
    let atSend: string[] = [];
    const spy: typeof fetch = async (i, o) => {
      if (o?.headers && new Headers(o.headers).has('payment-signature')) atSend = lines(ledger).map((l) => l.kind);
      return x.fetchImpl(i, o);
    };
    await new BuyPaidSource(CFG, ACCOUNT, spy, undefined, ledger).batch(CALLS, new AbortController().signal);
    expect(atSend).toEqual(['intent', 'nonce']); // both already on disk when the paid request leaves
    const l = lines(ledger);
    expect(l.map((e) => e.kind)).toEqual(['intent', 'nonce', 'outcome']);
    expect(l[0]).toMatchObject({ v: 1, kind: 'intent', capability: 'test-capability', payer: ACCOUNT.address, cap: '10000', nonce: null });
    expect(l[1]!.nonce).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(l[2]).toMatchObject({ status: 'responded', id: l[0]!.id });
  });

  it('a paid fetch that throws after the send is marked uncertain and reported as payment_uncertain, not as an unpaid failure', async () => {
    const ledger = new BuyIntentLedger(join(dir, 'buy-intents.jsonl'));
    const resets: typeof fetch = async (i, o) => {
      if (o?.headers && new Headers(o.headers).has('payment-signature')) throw new Error('connection reset');
      return x.fetchImpl(i, o);
    };
    await expect(new BuyPaidSource(CFG, ACCOUNT, resets, undefined, ledger).batch(CALLS, new AbortController().signal)).rejects.toThrow(/payment_uncertain/);
    const l = lines(ledger);
    expect(l.map((e) => e.kind)).toEqual(['intent', 'nonce', 'outcome']);
    expect(l[2]).toMatchObject({ status: 'uncertain', id: l[0]!.id });
    expect(ledger.spentOn('2026-11-10') + ledger.spentOn(new Date().toISOString().slice(0, 10))).toBeGreaterThanOrEqual(10_000n);
  });

  it('no durable intent, no send: if the intent cannot be written nothing is paid', async () => {
    const bad = new BuyIntentLedger(join(dir, 'file-not-dir', 'x', 'i.jsonl'));
    writeFileSync(join(dir, 'file-not-dir'), 'x');
    await expect(new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl, undefined, bad).batch(CALLS, new AbortController().signal)).rejects.toThrow();
    expect(x.payments).toHaveLength(0);
  });
});

describe('M3: the daily cap survives lost, damaged and uncertain state', () => {
  const guardWith = (ledger: BuyIntentLedger) => new BuySpendGuard(join(dir, 'g.json'), { settledSince: () => 0n }, () => {}, ledger);
  const today = (h = '12') => `2026-11-10T${h}:00:00.000Z`;
  const intent = (l: BuyIntentLedger, id: string, cap = '600000') => l.append({ v: 1, kind: 'intent', id, capability: 'c', payer: ACCOUNT.address, cap, nonce: null, timestamp: today() });

  it('deleting the state file does not reset today: spend is rebuilt from the ledger', () => {
    const ledger = new BuyIntentLedger(join(dir, 'i.jsonl'));
    const g = guardWith(ledger);
    intent(ledger, 'a');
    g.record(600_000n, NOW);
    rmSync(join(dir, 'g.json'));
    expect(g.state(NOW).spentAtomic).toBe('600000');
    expect(g.allow(400_000n, NOW)).toBe(true);
    expect(g.allow(400_001n, NOW)).toBe(false);
  });

  it('a corrupt state file is a guard fault (it throws), never a fresh day; so is a state with no usable fields', () => {
    const g = guardWith(new BuyIntentLedger(join(dir, 'i.jsonl')));
    for (const bad of ['{not json', '', '{}', '{"day":"2026-11-10","spentAtomic":"-1"}', 'null']) {
      writeFileSync(join(dir, 'g.json'), bad);
      expect(() => g.state(NOW), bad).toThrow(/corrupt/);
      expect(() => g.allow(1n, NOW), bad).toThrow();
    }
  });

  it('through the fetcher, a corrupt state means no paid call and Forno serves the read', async () => {
    writeFileSync(join(dir, 'g.json'), '{corrupt');
    const ledger = new BuyIntentLedger(join(dir, 'i.jsonl'));
    const logs: string[] = [];
    const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy: new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl, undefined, ledger), guard: guardWith(ledger), timeoutMs: 1000, log: (e) => logs.push(e) });
    expect((await f.fetch(PAY_TO, NOW)).source).toBe('forno');
    expect(logs).toContain('buy_guard_fault');
    expect(x.payments).toHaveLength(0);
    expect(x.unpaid).toBe(0);
  });

  it('uncertain intents count as spent: state deleted and no response ever seen, the cap still holds', () => {
    const ledger = new BuyIntentLedger(join(dir, 'i.jsonl'));
    intent(ledger, 'u');
    ledger.append({ v: 1, kind: 'outcome', id: 'u', status: 'uncertain', timestamp: today() });
    const g = guardWith(ledger);
    expect(g.state(NOW).spentAtomic).toBe('600000');
    expect(g.allow(400_000n, NOW)).toBe(true);
    expect(g.allow(400_001n, NOW)).toBe(false);
  });

  it('an intent with no outcome (crash mid-flight) counts too; another day does not', () => {
    const ledger = new BuyIntentLedger(join(dir, 'i.jsonl'));
    intent(ledger, 'crash');
    ledger.append({ v: 1, kind: 'intent', id: 'old', capability: 'c', payer: ACCOUNT.address, cap: '900000', nonce: null, timestamp: '2026-11-09T23:59:59.000Z' });
    expect(guardWith(ledger).state(NOW).spentAtomic).toBe('600000');
  });

  it('a damaged ledger is a guard fault, not zero spend', () => {
    const p = join(dir, 'i.jsonl');
    writeFileSync(p, '{"v":1,"kind":"intent"\n');
    expect(() => guardWith(new BuyIntentLedger(p)).state(NOW)).toThrow(/ledger/);
  });

  it('end to end: a paid call, then the state file deleted, then a second paid call within the cap is refused once the cap is reached', async () => {
    const wall = new Date(); // the ledger stamps intents with the wall clock
    const ledger = new BuyIntentLedger(join(dir, 'i.jsonl'));
    const cfg = { ...CFG, maxAmountAtomic: 100_000n };
    x.offers[0]!.amount = '100000';
    const mk = () => new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy: new BuyPaidSource(cfg, ACCOUNT, x.fetchImpl, undefined, ledger), guard: guardWith(ledger), timeoutMs: 1000 });
    for (let i = 0; i < 10; i++) {
      expect((await mk().fetch(PAY_TO, wall)).source).toBe('buy:test-capability');
      rmSync(join(dir, 'g.json'), { force: true });
    }
    const paidBefore = x.payments.length;
    expect((await mk().fetch(PAY_TO, wall)).source).toBe('forno'); // 10 x 0.10 = 1 USDC budget spent
    expect(x.payments.length).toBe(paidBefore);
    expect(readFileSync(join(dir, 'i.jsonl'), 'utf8').split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(10);
  });
});
