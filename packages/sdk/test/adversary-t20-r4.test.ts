import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ledger } from '../src/ledger.ts';
import type { PendingEntry } from '../src/types.ts';
import { makeWorld, type World } from './fakes/world.ts';

// Adversary pass on T20, round 4 (SPEC §7, §9, INVARIANTS.md). Each case is one concrete input or
// interleaving for which the SDK does something the spec forbids, or (the first) a property the
// fixed lock must keep.

let w: World | undefined;
let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await w?.close();
  w = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const ASSET = '0x1111111111111111111111111111111111111111';
function entry(id: string): PendingEntry {
  return {
    v: '1', requestId: `0x${id.repeat(32)}`, origin: 'https://risk.example', originHash: `0x${'11'.repeat(32)}`, method: 'POST',
    pathAndQuery: '/v1/evaluate', requestHash: `0x${id.repeat(32)}`, asset: ASSET, amount: '20000',
    payTo: '0x2222222222222222222222222222222222222222', payer: '0x3333333333333333333333333333333333333333', nonce: null,
    signedAtChain: null, signedAtBlock: null, validAfter: null, validBefore: null, agentId: '7', expectedSigner: null,
    state: 'reserved', code: null, settlementTx: null, createdAt: String(Date.now()), ...{},
  } as PendingEntry;
}
const ids = (d: string): string[] =>
  existsSync(join(d, 'pending.jsonl'))
    ? readFileSync(join(d, 'pending.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as PendingEntry).requestId)
    : [];
describe('adversary T20 r4: the lock', () => {
  // INV-19: "concurrent processes share one lock". The 10 s age rule breaks the lock of a holder
  // that is alive but stopped (Ctrl-Z of `attessa call`, laptop sleep, a paused WSL VM) inside the
  // critical section. Holder H has read the ledger; while it is stopped, B judges the lock stale by
  // age, breaks it, reserves and writes. H resumes and writes back its old snapshot: B's
  // reservation is gone. B may already have signed against it, so the cap no longer counts it.
  // (Either B must not get in, or its write must survive.)
  it('a stalled live holder whose lock is broken by age never erases the breaker\'s reservation', () => {
    dir = mkdtempSync(join(tmpdir(), 'attessa-ledger-'));
    const d = dir;
    const h = new Ledger(d);
    const b = new Ledger(d);
    let bGot: string | undefined;
    h.withLock((entries) => {
      // H has been stopped for 11 s inside the critical section.
      const old = (Date.now() - 11_000) / 1000;
      utimesSync(join(d, 'pending.lock'), old, old);
      try {
        bGot = String(b.reserve(entry('0b'), 10n ** 9n));
      } catch (e) {
        bGot = `threw: ${(e as Error).message.slice(0, 40)}`;
      }
      return { entries: [...entries, entry('0a')], result: undefined };
    });
    const survived = ids(d).includes(entry('0b').requestId);
    expect({ bGot, bReservationSurvived: bGot === 'reserved' ? survived : 'n/a' }).toEqual({
      bGot,
      bReservationSurvived: bGot === 'reserved' ? true : 'n/a',
    });
  }, 60_000);

  // A breaker that died holding the break mutex is cleared only if its pid is dead. When that pid
  // has been reused by a live process (a container restart hands out the same small pids; the
  // pending.lock age rule exists for exactly this), the mutex is never cleared, the dead holder's
  // pending.lock is never broken, and every ledger operation (V6, V8, every finish) throws forever.
  // SPEC §7 / T20: "a crash between V6 and V8 doesn't hold the reservation past 10 minutes".
  it('a dead breaker whose pid was reused does not lock the ledger forever', () => {
    dir = mkdtempSync(join(tmpdir(), 'attessa-ledger-'));
    const d = dir;
    writeFileSync(join(d, 'pending.lock'), '999999999 00000000000000aa');
    const mutex = join(d, 'pending.lock.breaker');
    mkdirSync(mutex);
    // The dead breaker's pid now belongs to a live process: this one stands in for it.
    writeFileSync(join(mutex, `${process.pid}-00000000000000bb`), '');
    // Both were left an hour ago.
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(join(d, 'pending.lock'), old, old);
    utimesSync(join(mutex, `${process.pid}-00000000000000bb`), old, old);
    utimesSync(mutex, old, old);
    // Let the 30 s lock timeout pass in milliseconds: each Date.now() call is 1 s later.
    let t = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000));
    let got: string;
    try {
      got = String(new Ledger(d).reserve(entry('0c'), 10n ** 9n));
    } catch (e) {
      got = (e as Error).message;
    }
    expect(got).toBe('reserved');
  });
});

describe('adversary T20 r4: terminal entries', () => {
  // SPEC §7 V12: "ledger entry terminal"; a decided call is never reopened. Two processes on one
  // dataDir (the CLI call, and `attessa status`/getResult in another terminal). A's paid POST drops
  // after a real settle, and A cannot reach /v1/results; while A retries, B's getResult fetches
  // the honest result and the entry ends `verified`. A then finishes its settled path and writes
  // `uncertain` over B's `verified`: the decided call is back in listPending.
  it('a call verified by another process is not reopened as uncertain', async () => {
    w = await makeWorld({ waitForExpiry: true });
    const world = w;
    const b = world.mkClient();
    let bResult: string | undefined;
    const aFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/v1/results/')) {
        const id = url.slice(url.lastIndexOf('/') + 1) as `0x${string}`;
        if (bResult === undefined) bResult = (await b.getResult(id)).outcome;
        throw new TypeError('fetch failed');
      }
      return fetch(input, init);
    };
    const a = world.mkClient({ fetch: aFetch });
    world.gw.behavior = { paid: 'drop_after_settle' };
    const r = await a.payAndVerify(world.url, { body: world.body });
    const state = JSON.parse(readFileSync(join(world.dataDir, 'pending.jsonl'), 'utf8').split('\n')[0]!).state;
    expect({ bResult, aOutcome: r.outcome, ledger: state }).toEqual({ bResult: 'verified', aOutcome: r.outcome, ledger: 'verified' });
  });
});
