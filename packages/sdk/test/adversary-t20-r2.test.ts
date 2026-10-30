import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, stringToBytes, type Hex } from 'viem';
import { requestHash } from '@attessa/core';
import { Ledger } from '../src/ledger.ts';
import type { PendingEntry } from '../src/types.ts';
import { makeWorld, type World } from './fakes/world.ts';

// Adversary pass on T20, round 2 (SPEC §7, §9, INVARIANTS.md). Each case is one concrete input for
// which the SDK does something the spec forbids.

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const entries = (dir: string): PendingEntry[] =>
  readFileSync(join(dir, 'pending.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const evidence = (dir: string): { requestId: string; outcome: string; code: string | null }[] => {
  const p = join(dir, 'evidence.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

describe('adversary T20 r2', () => {
  // INV-13: "Paid results are judged at their time anchors, so an honest result fetched late still
  // verifies"; SPEC §7: getResult "a result that passes V10 → verified". SPEC §7 ends an uncertain
  // call paid_but_rejected{missing_proof} only when there is "no result", not when /v1/results was
  // briefly unreachable. Here the paid POST drops after a real settle and /v1/results is unreachable
  // for the few seconds the SDK tries it; the honest result is then served, and getResult must
  // verify it.
  it('a settled call whose results endpoint was briefly unreachable still verifies through getResult', async () => {
    w = await makeWorld();
    const world = w;
    let resultsDown = true;
    const flaky: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (resultsDown && url.includes('/v1/results/')) throw new TypeError('fetch failed');
      return fetch(input, init);
    };
    const client = world.mkClient({ fetch: flaky });
    world.gw.behavior = { paid: 'drop_after_settle' };
    const r0 = await client.payAndVerify(world.url, { body: world.body });
    expect(world.chain.authUsed(world.gw.paid[0]!.ctx.payer, world.gw.paid[0]!.ctx.nonce)).toBe(true);

    // The gateway is reachable again; the stored, honest result is fetched 2 h later.
    resultsDown = false;
    world.chain.advance(7200);
    const r = await client.getResult(r0.requestId);
    expect({ first: r0.outcome, later: r.outcome, check: r.check }).toEqual({ first: r0.outcome, later: 'verified', check: undefined });
  });

  // INV-14: "A requestId is never paid twice". INV-19: every signed authorization is counted against
  // dailyCap until released or settled. Process A reserves requestId R at V6 and stalls in V7 past the
  // 10-minute TTL (SPEC §7: such an entry "was never signed and is deleted"). Process B's
  // reconcilePending drops it, then B pays R and verifies. When A resumes, V8 patches whatever entry
  // now holds R (B's settled one) with A's nonce and signs: R is signed twice and B's settled payment
  // disappears from the ledger.
  it('a reservation dropped by the 10-minute sweep never lets its stalled owner sign over another entry', async () => {
    w = await makeWorld({ waitForExpiry: false });
    const world = w;
    const R = keccak256(stringToBytes(`stall-${Math.random()}`)) as Hex;
    const later = world.mkClient({ now: () => Date.now() + 11 * 60_000 });
    const real = world.chain.request.bind(world.chain);
    let fired = false;
    let bResult: Awaited<ReturnType<typeof later.payAndVerify>> | undefined;
    world.chain.request = async (method, params) => {
      if (!fired && method === 'eth_call' && new Ledger(world.dataDir).get(R)?.state === 'reserved') {
        fired = true; // A is in V7 now, holding an unsigned reservation for R.
        await later.reconcilePending();
        bResult = await later.payAndVerify(world.url, { body: world.body, requestId: R });
      }
      return real(method, params);
    };
    const a = await world.client.payAndVerify(world.url, { body: world.body, requestId: R });

    const forR = entries(world.dataDir).filter((e) => e.requestId === R);
    const bNonce = world.gw.paid[0]?.ctx.nonce;
    console.log(JSON.stringify({ a: [a.outcome, a.code], b: [bResult?.outcome, bResult?.code], signatures: world.transferSignatures(), settled: world.gw.paid.length, ledger: forR.map((e) => [e.state, e.nonce]) , bNonce }));
    expect(bResult?.outcome).toBe('verified');
    expect(world.transferSignatures()).toBe(1);
    expect(forR.map((e) => ({ state: e.state, nonce: e.nonce }))).toEqual([{ state: 'verified', nonce: bNonce }]);
  });

  // SPEC §9 minimal guarantee: "Every outcome is in evidence." A call that V0 (under the V6 lock)
  // sends to wait on another process's reservation and that ends `stopped{in_progress}` writes no
  // evidence row.
  it('a call that ends stopped{in_progress} at V0 has an evidence row', async () => {
    w = await makeWorld();
    const world = w;
    const other: PendingEntry = {
      v: '1', requestId: `0x${'ab'.repeat(32)}`, origin: world.origin, originHash: world.gw.originHash, method: 'POST',
      pathAndQuery: '/v1/evaluate', requestHash: requestHash('POST', '/v1/evaluate', new TextEncoder().encode(world.body)),
      asset: world.chain.asset, amount: '20000', payTo: world.payTo, payer: world.account.address.toLowerCase() as Hex,
      nonce: null, signedAtChain: null, signedAtBlock: null, validAfter: null, validBefore: null, agentId: '7', expectedSigner: null,
      state: 'reserved', code: null, settlementTx: null, createdAt: String(Date.now()),
    };
    world.gw.behavior = {
      unpaid: () => {
        new Ledger(world.dataDir).reserve(other, 10n ** 9n);
        return false;
      },
    };
    const r = await world.client.payAndVerify(world.url, { body: world.body });
    expect({ outcome: r.outcome, code: r.code }).toEqual({ outcome: 'stopped', code: 'in_progress' });
    expect(evidence(world.dataDir).filter((e) => e.outcome === 'stopped' && e.code === 'in_progress')).toHaveLength(1);
  });
});
