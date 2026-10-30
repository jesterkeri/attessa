import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger, RESERVATION_TTL_MS, spendToday } from '../src/ledger.ts';
import type { PendingEntry } from '../src/types.ts';
import { makeWorld, PRICE, type World } from './fakes/world.ts';

const child = fileURLToPath(new URL('./helpers/reserve-child.ts', import.meta.url));
const ASSET = '0x01c5c0122039549ad1493b8220cabedd739bc44e' as const;

function run(dir: string, tag: string, count: number, amount: number, cap: number, startAt: number): Promise<{ reserved: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [child, dir, tag, String(count), String(amount), String(cap), String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child ${tag} exited ${code}: ${err}`))));
  });
}

function entry(over: Partial<PendingEntry>): PendingEntry {
  return {
    v: '1', requestId: `0x${'01'.repeat(32)}`, origin: 'https://risk.example', originHash: `0x${'11'.repeat(32)}`, method: 'POST',
    pathAndQuery: '/v1/evaluate', requestHash: `0x${'22'.repeat(32)}`, asset: ASSET, amount: '20000',
    payTo: '0x2222222222222222222222222222222222222222', payer: '0x3333333333333333333333333333333333333333', nonce: null,
    signedAtChain: null, signedAtBlock: null, validAfter: null, validBefore: null, agentId: '7', expectedSigner: null,
    state: 'reserved', code: null, settlementTx: null, createdAt: String(Date.now()), ...over,
  };
}

let dir = '';
let w: World | undefined;
afterEach(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
  await w?.close();
  w = undefined;
});

describe('INV-19: reservations are shared across processes', () => {
  it('two processes racing on one dataDir never reserve more than dailyCap in total', async () => {
    dir = mkdtempSync(join(tmpdir(), 'attessa-race-'));
    const startAt = Date.now() + 1500;
    const [a, b] = await Promise.all([run(dir, 'a', 60, 1, 70, startAt), run(dir, 'b', 60, 1, 70, startAt)]);
    const all = new Ledger(dir).list();
    // Exactly the cap was reserved, every reservation is in the file, and both processes got some.
    expect(a.reserved + b.reserved).toBe(70);
    expect(all).toHaveLength(70);
    expect(a.reserved).toBeGreaterThan(0);
    expect(b.reserved).toBeGreaterThan(0);
    expect(spendToday(all, ASSET, Date.now())).toBe(70n);
  }, 60_000);
});

describe('spend accounting (SPEC §7)', () => {
  it('counts reserved, signed, refused, uncertain, settle_pending and settled outcomes; not not_charged', () => {
    const now = Date.now();
    const states = ['reserved', 'signed', 'refused', 'uncertain', 'settle_pending', 'verified', 'paid_but_rejected', 'settled_after_refusal', 'not_charged'] as const;
    const es = states.map((s, i) => entry({ requestId: `0x${String(i).padStart(64, '0')}`, state: s, amount: '1' }));
    expect(spendToday(es, ASSET, now)).toBe(8n);
  });

  it('settled spend from a previous UTC day does not count; open reservations from then still do', () => {
    const yesterday = String(Date.now() - 86_400_000 - 1000);
    const es = [entry({ state: 'verified', createdAt: yesterday }), entry({ state: 'uncertain', createdAt: yesterday, requestId: `0x${'02'.repeat(32)}` })];
    expect(spendToday(es, ASSET, Date.now())).toBe(20000n);
  });

  it('other assets are separate', () => {
    expect(spendToday([entry({ asset: '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771' })], ASSET, Date.now())).toBe(0n);
  });
});

describe('a crash between V6 and V8 holds the reservation at most 10 minutes', () => {
  it('an unsigned reservation older than 10 minutes is dropped at the next V6; a younger one still counts', async () => {
    w = await makeWorld({ limits: { dailyCap: PRICE } });
    const pending = join(w.dataDir, 'pending.jsonl');
    const crashed = (ageMs: number) =>
      writeFileSync(pending, JSON.stringify(entry({ requestHash: `0x${'77'.repeat(32)}`, createdAt: String(Date.now() - ageMs), asset: w!.chain.asset })) + '\n');

    crashed(RESERVATION_TTL_MS - 60_000);
    const blocked = await w.client.payAndVerify(w.url, { body: w.body });
    expect(blocked).toMatchObject({ outcome: 'stopped', code: 'over_daily_cap' });
    expect(w.transferSignatures()).toBe(0);

    crashed(RESERVATION_TTL_MS + 1000);
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('verified');
    const left = new Ledger(w.dataDir).list();
    expect(left).toHaveLength(1);
    expect(left[0]!.requestId).toBe(r.requestId);
  });

  it('reconcilePending also drops stale unsigned reservations', async () => {
    w = await makeWorld();
    writeFileSync(join(w.dataDir, 'pending.jsonl'), JSON.stringify(entry({ createdAt: String(Date.now() - RESERVATION_TTL_MS - 1) })) + '\n');
    await w.client.reconcilePending();
    expect(new Ledger(w.dataDir).list()).toHaveLength(0);
  });

  it('a signed entry is never dropped by the sweep, however old', () => {
    dir = mkdtempSync(join(tmpdir(), 'attessa-ledger-'));
    const l = new Ledger(dir);
    writeFileSync(join(dir, 'pending.jsonl'), JSON.stringify(entry({ state: 'signed', nonce: `0x${'33'.repeat(32)}`, createdAt: '0' })) + '\n');
    expect(l.reserve(entry({ requestId: `0x${'09'.repeat(32)}` }), 10n ** 9n)).toBe('reserved');
    expect(l.list()).toHaveLength(2);
  });

  it('a lock left by a dead process is broken', () => {
    dir = mkdtempSync(join(tmpdir(), 'attessa-ledger-'));
    const l = new Ledger(dir);
    writeFileSync(join(dir, 'pending.lock'), '999999999');
    expect(l.reserve(entry({}), 10n ** 9n)).toBe('reserved');
  });
});
