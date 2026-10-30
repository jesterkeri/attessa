import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
const esrch = (): never => {
  throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
};

describe('adversary T20 r4: the lock', () => {
  // Rewrite of r3's "a breaker clearing a dead break marker never lets two processes into the
  // critical section". The r3 version had simulated B take the lock and never release it, so a
  // correct lock could only wait (and then break B under the 10 s age rule, or time out at 30 s),
  // and the assertion rejected both. Here B, like a real process, releases as soon as A is waiting
  // on its live lock. The property: A never runs while B holds the lock, and B's write survives.
  //
  // Interleaving (every peer step is what ledger.ts does in another process): holder H died in the
  // critical section; breaker D died holding the break mutex. A reads D as dead; meanwhile B also
  // clears D and takes the mutex. B then finishes its break at A's k-th reading of H's lock, takes
  // the lock and writes an entry. When A probes B's live pid, B releases.
  for (const k of [1, 2, 3]) {
    it(`a dead breaker cleared by two waiters at once never lets them both in (B finishes at probe ${k})`, () => {
      dir = mkdtempSync(join(tmpdir(), 'attessa-ledger-'));
      const d = dir;
      const lockPath = join(d, 'pending.lock');
      const mutex = join(d, 'pending.lock.breaker');
      const DEAD_HOLDER = 999999999;
      const DEAD_BREAKER = 999999998;
      const holderToken = `${DEAD_HOLDER} 00000000000000aa`;
      const deadOwner = `${DEAD_BREAKER}-00000000000000bb`;
      const bOwner = `${process.pid}-b0b0b0b0b0b0b0b0`;
      const bToken = `${process.pid} b0b0b0b0b0b0b0b0`;
      writeFileSync(lockPath, holderToken);
      mkdirSync(mutex);
      writeFileSync(join(mutex, deadOwner), '');
      const a = new Ledger(d);

      const realKill = process.kill.bind(process);
      let bMidBreak = false;
      let bHolds = false;
      let holderProbes = 0;
      vi.spyOn(process, 'kill').mockImplementation((pid: number, sig?: string | number) => {
        if (pid === DEAD_BREAKER) {
          if (!bMidBreak && existsSync(join(mutex, deadOwner))) {
            // B clears the dead owner by exact name, rmdirs, and renames its own one-file dir in.
            unlinkSync(join(mutex, deadOwner));
            rmdirSync(mutex);
            mkdirSync(mutex);
            writeFileSync(join(mutex, bOwner), '');
            bMidBreak = true;
          }
          return esrch();
        }
        if (pid === DEAD_HOLDER) {
          holderProbes++;
          if (bMidBreak && holderProbes >= k && existsSync(lockPath) && readFileSync(lockPath, 'utf8') === holderToken) {
            // B under the mutex: re-read equals what it judged stale, unlink, release the mutex,
            // acquire, write its entry.
            unlinkSync(lockPath);
            rmSync(join(mutex, bOwner), { force: true });
            try {
              rmdirSync(mutex);
            } catch {
              // not empty: someone else's
            }
            writeFileSync(lockPath, bToken);
            bMidBreak = false;
            bHolds = true;
            // The ledger was empty when B read it.
            writeFileSync(join(d, 'pending.jsonl'), JSON.stringify(entry('0b')) + '\n');
          }
          return esrch();
        }
        if (pid === process.pid && bHolds && existsSync(lockPath) && readFileSync(lockPath, 'utf8') === bToken) {
          // A waits on B's live lock: B leaves its critical section.
          unlinkSync(lockPath);
          bHolds = false;
        }
        return realKill(pid, sig);
      });

      const overlap = a.withLock((entries) => ({ entries: [...entries, entry('0a')], result: bHolds }));
      expect({ overlap, entries: ids(d).sort() }).toEqual({ overlap: false, entries: [entry('0a').requestId, entry('0b').requestId].sort() });
    });
  }

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
