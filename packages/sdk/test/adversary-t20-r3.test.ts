import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
