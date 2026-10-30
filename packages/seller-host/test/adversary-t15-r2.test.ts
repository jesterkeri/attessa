import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// The gateway's own store writes the rows, so the schema, WAL mode and transitions are the real ones (SPEC §6.4).
import { CallStore, type CallState } from '../../gateway/src/db.ts';
import { BuySpendGuard, GatewayDbRevenue, ONE_USDC, utcDay } from '../src/guard.ts';

/** Adversary pass on T15, round 2 (seller-host side): revenue dated by created_at. Temp SQLite files only. */

const dirs: string[] = [];
const tz = process.env.TZ;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

function dbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'adv-t15-r2-'));
  dirs.push(d);
  return join(d, 'sepolia.db');
}

const DAY = Date.UTC(2026, 9, 30) / 1000; // 2026-10-30 00:00:00 UTC

function rid(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

/** Inserts a row the way the gateway does (payment_verified at `at`) and returns its request id. */
function insert(store: CallStore, n: number, amount: string, at: number): string {
  const request_id = rid(n);
  store.insertVerified(
    {
      request_id,
      payer: '0x2222222222222222222222222222222222222222',
      asset: '0x01c5c0122039549ad1493b8220cabedd739bc44e',
      pay_to: '0x1111111111111111111111111111111111111111',
      amount,
      auth_nonce: `0x${n.toString(16).padStart(64, 'f')}`,
      valid_before: at + 120,
      request_hash: `0x${'ab'.repeat(32)}`,
      created_block: 1,
    },
    at,
  );
  return request_id;
}

/** The legal path to each SPEC §6.4 state, as the gateway and reconciler walk it (SPEC §6.2, §6.3). */
const PATHS: Record<CallState, CallState[]> = {
  payment_verified: [],
  executing: ['executing'],
  exec_failed: ['exec_failed'],
  proof_rejected: ['executing', 'proof_rejected'],
  too_late: ['executing', 'too_late'],
  settling: ['executing', 'settling'],
  settle_pending: ['executing', 'settling', 'settle_pending'],
  settled: ['executing', 'settling', 'settled'],
  settle_failed: ['executing', 'settling', 'settle_pending', 'settle_failed'],
  delivered: ['executing', 'settling', 'settled', 'delivered'],
  delivery_failed: ['executing', 'settling', 'settled', 'delivery_failed'],
};

function walk(store: CallStore, id: string, to: CallState, at: number): void {
  let from: CallState = 'payment_verified';
  let t = at;
  for (const s of PATHS[to]) {
    expect(store.transition(id, [from], s, ++t)).toBe(true);
    from = s;
  }
}

describe('adversary T15 r2: revenue by created_at across every SPEC §6.4 state', () => {
  it('only settled, delivered and delivery_failed count; refused, expired, failed and open rows do not', () => {
    const path = dbPath();
    const store = new CallStore(path);
    try {
      const states = Object.keys(PATHS) as CallState[];
      states.forEach((s, i) => walk(store, insert(store, i + 1, '1000000', DAY + 100 + i * 10), s, DAY + 100 + i * 10));
      // settle_failed{nonce_used_elsewhere} records a tx hash but was never charged by us (SPEC §6.3 step 2).
      store.note(rid(states.indexOf('settle_failed') + 1), { reject_reason: 'nonce_used_elsewhere', settle_tx: `0x${'cd'.repeat(32)}` }, DAY + 500);
      expect(store.countsByState()).toEqual(Object.fromEntries(states.map((s) => [s, 1])));
      expect(new GatewayDbRevenue(path).settledSince(DAY)).toBe(3_000_000n);
    } finally {
      store.close();
    }
  });

  it('a settled row keeps its single count through delivery and retention, on the day it was created', () => {
    const path = dbPath();
    const store = new CallStore(path);
    const rev = new GatewayDbRevenue(path);
    try {
      const id = insert(store, 1, '750000', DAY + 50);
      walk(store, id, 'settled', DAY + 50);
      expect(rev.settledSince(DAY)).toBe(750_000n);
      expect(store.transition(id, ['settled'], 'delivered', DAY + 86_400 + 5, { result_expires_at: DAY + 2 * 86_400 })).toBe(true);
      store.applyRetention(DAY + 3 * 86_400);
      expect(rev.settledSince(DAY)).toBe(750_000n);
      expect(rev.settledSince(DAY + 86_400)).toBe(0n);
    } finally {
      store.close();
    }
  });

  it('day boundary: created one second before 00:00 UTC is yesterday, at 00:00:00 is today', () => {
    const path = dbPath();
    const store = new CallStore(path);
    try {
      walk(store, insert(store, 1, '100', DAY - 1), 'delivered', DAY - 1);
      walk(store, insert(store, 2, '200', DAY), 'delivered', DAY);
      const rev = new GatewayDbRevenue(path);
      expect(rev.settledSince(DAY)).toBe(200n);
      expect(rev.settledSince(DAY - 86_400)).toBe(300n);
    } finally {
      store.close();
    }
  });

  it('uncommitted gateway writes are not revenue; committed WAL writes are, without a checkpoint', () => {
    const path = dbPath();
    const store = new CallStore(path);
    try {
      walk(store, insert(store, 1, '400000', DAY + 10), 'settled', DAY + 10);
      store.db.exec('BEGIN IMMEDIATE');
      walk(store, insert(store, 2, '900000', DAY + 20), 'settled', DAY + 20);
      expect(new GatewayDbRevenue(path).settledSince(DAY)).toBe(400_000n);
      store.db.exec('COMMIT');
      expect(new GatewayDbRevenue(path).settledSince(DAY)).toBe(1_300_000n);
    } finally {
      store.close();
    }
  });

  it('amounts that are not canonical decimal integers are skipped, not parsed', () => {
    const path = dbPath();
    const store = new CallStore(path);
    try {
      ['1e6', '-5', '0x10', ' 7', '007', '1.5', ''].forEach((a, i) => walk(store, insert(store, i + 1, a, DAY + i), 'settled', DAY + i));
      walk(store, insert(store, 99, '123', DAY + 99), 'settled', DAY + 99);
      expect(new GatewayDbRevenue(path).settledSince(DAY)).toBe(123n);
    } finally {
      store.close();
    }
  });
});

describe('adversary T15 r2: the guard day is UTC whatever the host time zone', () => {
  for (const zone of ['Pacific/Kiritimati', 'Etc/GMT+12', 'America/St_Johns']) {
    it(`TZ=${zone}: yesterday's revenue and spend do not carry into today, today's does`, () => {
      process.env.TZ = zone;
      const path = dbPath();
      const store = new CallStore(path);
      try {
        // 2 USDC created 23:30 UTC yesterday, 0.5 USDC created 00:30 UTC today.
        walk(store, insert(store, 1, '2000000', DAY - 1800), 'delivered', DAY - 1800);
        walk(store, insert(store, 2, '500000', DAY + 1800), 'delivered', DAY + 1800);
        const guard = new BuySpendGuard(join(path, '..', 'guard.json'), new GatewayDbRevenue(path));
        const yesterday = new Date((DAY - 600) * 1000);
        guard.record(2_000_000n, yesterday);
        const now = new Date((DAY + 3600) * 1000);
        expect(utcDay(now)).toBe('2026-10-30');
        expect(guard.state(now).spentAtomic).toBe('0');
        // Today's budget: 0.5 USDC revenue + 1 USDC = 1.5 USDC.
        expect(guard.allow(1_500_000n, now)).toBe(true);
        expect(guard.allow(1_500_001n, now)).toBe(false);
        expect(guard.state(now).tripped).toBe(true);
        // Yesterday's 2 USDC of revenue was its own budget, not today's.
        expect(guard.allow(ONE_USDC + 1n, yesterday)).toBe(true);
      } finally {
        store.close();
      }
    });
  }
});
