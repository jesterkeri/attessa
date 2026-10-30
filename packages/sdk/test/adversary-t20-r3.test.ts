import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ledger } from '../src/ledger.ts';
import type { PendingEntry } from '../src/types.ts';
import { makeWorld, type World } from './fakes/world.ts';

// Adversary pass on T20, round 3 (SPEC §7, §9, INVARIANTS.md). Each case is one concrete input or
// interleaving for which the SDK does something the spec forbids.

let w: World | undefined;
let dir: string | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const entries = (d: string): PendingEntry[] =>
  readFileSync(join(d, 'pending.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const evidence = (d: string): { requestId: string; outcome: string; code: string | null }[] => {
  const p = join(d, 'evidence.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

describe('adversary T20 r3', () => {
  // INV-19: "concurrent processes share one lock". The break lock (pending.lock.break) is what keeps
  // two breakers apart, but a waiter that finds a stale break marker removes the marker by path
  // without re-checking that it is still the stale one. Interleaving, with every peer step being
  // exactly what ledger.ts does in another process:
  //   - holder H died inside the critical section (pending.lock = dead pid), and breaker D died
  //     mid-break (pending.lock.break = dead pid);
  //   - A reads D's marker as stale; meanwhile B also clears it and takes the break lock;
  //   - A unlinks the marker by path: B's live one. A then takes the break lock as well;
  //   - both re-check pending.lock = H's token; B unlinks it and acquires; A unlinks B's live lock
  //     and acquires too.
  // A and B are then both inside withLock: two V6 cap checks can both pass (INV-19).
  it('a breaker clearing a dead break marker never lets two processes into the critical section', () => {
    dir = mkdtempSync(join(tmpdir(), 'attessa-ledger-'));
    const lockPath = join(dir, 'pending.lock');
    const breakPath = join(dir, 'pending.lock.break');
    const DEAD_HOLDER = 999999999;
    const DEAD_BREAKER = 999999998;
    const holderToken = `${DEAD_HOLDER} 00000000000000aa`;
    writeFileSync(lockPath, holderToken);
    writeFileSync(breakPath, `${DEAD_BREAKER} 00000000000000bb`);
    const a = new Ledger(dir);

    const realKill = process.kill.bind(process);
    let holderProbes = 0;
    let bHoldsLock = false;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number, sig?: string | number) => {
      if (pid === DEAD_BREAKER) {
        // A has read D's marker and is judging it. B (live, this pid) also judged it stale, cleared
        // it, and created its own break marker: B is now mid-break.
        if (readFileSync(breakPath, 'utf8').startsWith(String(DEAD_BREAKER))) {
          unlinkSync(breakPath);
          writeFileSync(breakPath, `${process.pid} b-break`);
        }
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      if (pid === DEAD_HOLDER) {
        holderProbes++;
        // Probe 1: A's first reading. Probe 2: A's second reading, before taking the break lock.
        // Probe 3: A's re-check under the break lock has read H's token. B, still believing it holds
        // the break lock, re-checks the same token, unlinks it, removes the break marker in its
        // `finally`, and acquires pending.lock.
        if (holderProbes === 3 && readFileSync(lockPath, 'utf8') === holderToken) {
          unlinkSync(lockPath);
          rmSync(breakPath, { force: true });
          writeFileSync(lockPath, `${process.pid} b-lock`);
          bHoldsLock = true;
        }
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      return realKill(pid, sig);
    });
    try {
      const enteredWhileBHeld = a.withLock(() => ({ result: bHoldsLock }));
      expect({ bTookTheLock: bHoldsLock, aEnteredWhileBHeldTheLock: enteredWhileBHeld }).toEqual({
        bTookTheLock: true,
        aEnteredWhileBHeldTheLock: false,
      });
    } finally {
      kill.mockRestore();
    }
  });

  // SPEC §7 V12: "ledger entry terminal". SPEC §7 V10: "An RPC error is never a ProofCheck". A
  // verified call is decided. Calling getResult on it later, while the buyer's RPC cannot serve the
  // receipt, must not move the entry out of `verified`: here it becomes `uncertain` again and
  // reappears in listPending, so `attessa status --pending` shows a finished, verified call as open.
  it('getResult on a verified call during an RPC outage leaves the entry verified', async () => {
    w = await makeWorld();
    const r0 = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r0.outcome).toBe('verified');

    w.chain.failing.add('eth_getTransactionReceipt');
    await w.client.getResult(r0.requestId);
    const e = entries(w.dataDir).find((x) => x.requestId === r0.requestId)!;
    const pending = (await w.client.listPending()).map((x) => x.requestId);
    expect({ state: e.state, inPending: pending.includes(r0.requestId) }).toEqual({ state: 'verified', inPending: false });
  });

  // SPEC §7 "refused / uncertain → final": "if found, first call getResult: a result that passes
  // V10 → verified; ... no result and the call was refused → settled_after_refusal". INV-23. The r2
  // fix made only the gateway's 404 result_not_found count as "no result" for an uncertain call;
  // a refused call still ends settled_after_refusal (terminal) when /v1/results is merely
  // unreachable, and a later getResult never verifies the honest stored result.
  it('a refused-yet-settled call whose results endpoint was briefly unreachable still verifies through getResult', async () => {
    w = await makeWorld();
    const world = w;
    let resultsDown = true;
    const flaky: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (resultsDown && url.includes('/v1/results/')) throw new TypeError('fetch failed');
      return fetch(input, init);
    };
    const client = world.mkClient({ fetch: flaky });
    world.gw.behavior = { paid: 'refuse_with_result' };
    const r0 = await client.payAndVerify(world.url, { body: world.body });
    expect(world.chain.authUsed(world.gw.paid[0]!.ctx.payer, world.gw.paid[0]!.ctx.nonce)).toBe(true);

    resultsDown = false;
    world.chain.advance(200);
    const r = await client.getResult(r0.requestId);
    expect({ first: r0.outcome, later: r.outcome }).toEqual({ first: r0.outcome, later: 'verified' });
    expect(evidence(world.dataDir).at(-1)?.outcome).toBe('verified');
  });
});
