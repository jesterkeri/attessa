import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuySpendGuard, GatewayDbRevenue, ONE_USDC, type RevenueSource } from '../src/guard.ts';
import { HttpRpcSource, InputFetcher, InputsUnavailable, readInputsFrom, type BuySource, type RpcCall } from '../src/inputs.ts';
import { FakeRpc } from './fake-rpc.ts';

const PAY_TO = '0x2222222222222222222222222222222222222222';
let forno: FakeRpc;
let paid: FakeRpc;

beforeEach(async () => {
  forno = new FakeRpc();
  await forno.start();
  paid = new FakeRpc();
  await paid.start();
  forno.accounts.set(PAY_TO, { code: '0x60016002', nonce: 3n, balance: 10n ** 18n });
  paid.accounts.set(PAY_TO, { code: '0x60016002', nonce: 3n, balance: 10n ** 18n });
});
afterEach(async () => {
  await forno.stop();
  await paid.stop();
});

function buySource(rpc: FakeRpc, cost = 5_000n): BuySource & { calls: RpcCall[][] } {
  const inner = new HttpRpcSource('buy:celo-rpc', rpc.url);
  const calls: RpcCall[][] = [];
  return {
    id: 'buy:celo-rpc',
    costPerEvaluate: cost,
    calls,
    batch: (c, s) => {
      calls.push(c);
      return inner.batch(c, s);
    },
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'attessa-guard-'));
}

const fixedRevenue = (v: bigint): RevenueSource & { calls: number[] } => {
  const calls: number[] = [];
  return { calls, settledSince: (d) => (calls.push(d), v) };
};

describe('input fetch (SPEC §5)', () => {
  it('reads block N = latest − 1 and the three account reads at N, lowercased, decimal strings', async () => {
    forno.head = 0x1234n;
    const i = await readInputsFrom(new HttpRpcSource('forno', forno.url), PAY_TO, 1000);
    expect(i).toEqual({
      block: { number: (0x1233).toString(), hash: forno.blockHash(0x1233n), timestamp: (1_700_000_000n + 0x1233n).toString() },
      payTo: { address: PAY_TO, code: '0x60016002', nonce: '3', balanceWei: (10n ** 18n).toString() },
      source: 'forno',
    });
  });

  it('refuses a node that answers for a different block', async () => {
    forno.mode = 'wrong_block';
    await expect(readInputsFrom(new HttpRpcSource('forno', forno.url), PAY_TO, 1000)).rejects.toThrow(/block number differs/);
  });

  it('refuses a per-call JSON-RPC error', async () => {
    forno.mode = 'rpc_error';
    await expect(readInputsFrom(new HttpRpcSource('forno', forno.url), PAY_TO, 1000)).rejects.toThrow(/failed/);
  });

  it('times out a hanging source, falls back to Forno once, then gives inputs_unavailable', async () => {
    forno.mode = 'hang';
    const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), timeoutMs: 150 });
    const t0 = Date.now();
    await expect(f.fetch(PAY_TO)).rejects.toBeInstanceOf(InputsUnavailable);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(forno.requests).toHaveLength(2);
  });

  it('uses buy as primary while the guard allows it, as one batch of the four reads, and labels the source', async () => {
    const dir = tmp();
    const buy = buySource(paid);
    const guard = new BuySpendGuard(join(dir, 'guard.json'), fixedRevenue(0n));
    const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy, guard, timeoutMs: 1000 });
    const i = await f.fetch(PAY_TO, new Date('2026-11-10T12:00:00Z'));
    expect(i.source).toBe('buy:celo-rpc');
    expect(buy.calls.at(-1)!.map((c) => c.method)).toEqual(['eth_getBlockByNumber', 'eth_getCode', 'eth_getTransactionCount', 'eth_getBalance']);
    expect(forno.requests).toHaveLength(0);
    expect(guard.state(new Date('2026-11-10T13:00:00Z')).spentAtomic).toBe('5000');
  });

  it('falls back to Forno with source "forno" when buy fails, and still counts the paid attempt', async () => {
    const dir = tmp();
    paid.mode = 'http500';
    const guard = new BuySpendGuard(join(dir, 'guard.json'), fixedRevenue(0n));
    const logs: string[] = [];
    const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy: buySource(paid), guard, timeoutMs: 1000, log: (e) => logs.push(e) });
    const now = new Date('2026-11-10T12:00:00Z');
    expect((await f.fetch(PAY_TO, now)).source).toBe('forno');
    expect(logs).toContain('inputs_primary_failed');
    expect(guard.state(now).spentAtomic).toBe('5000');
  });
});

describe('buy-spend guard (SPEC §5)', () => {
  const now = new Date('2026-11-10T12:00:00Z');

  it('allows paid reads up to settled revenue + 1 USDC, then switches to Forno and records the trip', async () => {
    const dir = tmp();
    const path = join(dir, 'guard.json');
    const revenue = fixedRevenue(40_000n);
    const logs: Array<[string, unknown]> = [];
    const guard = new BuySpendGuard(path, revenue, (e, f) => logs.push([e, f]));
    const buy = buySource(paid, 260_000n);
    const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy, guard, timeoutMs: 1000 });
    // Budget 1.04 USDC: four reads of 0.26 = 1.04 fit exactly; the fifth goes to Forno.
    for (let i = 0; i < 4; i++) expect((await f.fetch(PAY_TO, now)).source).toBe('buy:celo-rpc');
    expect(guard.state(now)).toEqual({ day: '2026-11-10', spentAtomic: '1040000', tripped: false });
    expect((await f.fetch(PAY_TO, now)).source).toBe('forno');
    expect((await f.fetch(PAY_TO, now)).source).toBe('forno');
    expect(buy.calls.length).toBe(8); // two requests per paid fetch, none after the trip
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ day: '2026-11-10', spentAtomic: '1040000', tripped: true });
    expect(logs.filter(([e]) => e === 'buy_budget_tripped')).toHaveLength(1);
    // The revenue window starts at 00:00 UTC.
    expect(revenue.calls.every((d) => d === Date.UTC(2026, 10, 10) / 1000)).toBe(true);
  });

  it('starts a new UTC day at zero', () => {
    const dir = tmp();
    const guard = new BuySpendGuard(join(dir, 'g.json'), fixedRevenue(0n));
    guard.record(ONE_USDC, new Date('2026-11-10T23:59:59Z'));
    expect(guard.allow(1n, new Date('2026-11-10T23:59:59Z'))).toBe(false);
    expect(guard.allow(ONE_USDC, new Date('2026-11-11T00:00:00Z'))).toBe(true);
  });

  it('a buy source without a guard is a configuration error', async () => {
    const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy: buySource(paid) });
    await expect(f.fetch(PAY_TO)).rejects.toThrow(/budget guard/);
  });

  it('reads settled revenue for the day from the gateway database, read-only', () => {
    const dir = tmp();
    const dbPath = join(dir, 'sepolia.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE calls (request_id TEXT PRIMARY KEY, amount TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    const day = Date.UTC(2026, 10, 10) / 1000;
    const ins = db.prepare('INSERT INTO calls VALUES (?, ?, ?, ?)');
    ins.run('a', '20000', 'delivered', day + 10);
    ins.run('b', '20000', 'settled', day + 20);
    ins.run('c', '20000', 'delivery_failed', day + 30);
    ins.run('d', '20000', 'settle_pending', day + 40); // not settled
    ins.run('e', '20000', 'exec_failed', day + 50);
    ins.run('f', '20000', 'delivered', day - 1); // yesterday
    db.close();
    expect(new GatewayDbRevenue(dbPath).settledSince(day)).toBe(60_000n);
  });

  it('counts an unreadable gateway database as zero revenue, so the guard trips sooner', () => {
    const logs: string[] = [];
    expect(new GatewayDbRevenue('/nonexistent/x.db', (e) => logs.push(e)).settledSince(0)).toBe(0n);
    expect(logs).toEqual(['revenue_unreadable']);
  });
});
