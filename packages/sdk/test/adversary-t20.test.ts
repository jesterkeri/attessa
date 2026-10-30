import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, stringToBytes, type Hex } from 'viem';
import { spendToday } from '../src/ledger.ts';
import { makeWorld, type World } from './fakes/world.ts';

// Adversary pass on T20 (SPEC §7). Each case is one concrete input for which the SDK does something
// SPEC §7 or INVARIANTS.md forbids.

let w: World;
afterEach(async () => w?.close());

const entries = (dir: string) =>
  readFileSync(join(dir, 'pending.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('adversary T20', () => {
  // SPEC §7 V10 / §6.2 step 9: "eth_getBlockByNumber(inputs.block.number) hash and timestamp equal
  // inputs.block"; INV-13: "any failure returns the specific ProofCheck"; "An RPC error is never a
  // ProofCheck" does not make a fabricated block an RPC error. The claimed block does not exist, so
  // the hash cannot equal it, and its timestamp check (<= S) is decidable from the response alone.
  it('a settled result whose inputs name a block that does not exist ends paid_but_rejected, not uncertain{rpc_unavailable}', async () => {
    w = await makeWorld();
    w.gw.behavior = {
      paid: 'deliver',
      inputs: (i) => ({
        ...i,
        block: { ...(i.block as object), number: '99999999', hash: keccak256(stringToBytes('no such block')) },
      }),
    };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.settlementTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect({ outcome: r.outcome, code: r.code }).toEqual({ outcome: 'paid_but_rejected', code: 'proof_rejected' });
    expect(['inputs_mismatch', 'stale_inputs']).toContain(r.check);
  });

  // SPEC §7 V9: "A 4xx/5xx with a well-formed §10 body whose requestId matches → refused (+ code).
  // Any other non-2xx ... → uncertain". `constructor` is not a §10 code; it passes only because the
  // code test is `err.error in GATEWAY_ERRORS`, which also matches Object.prototype keys.
  it('a 502 whose "error" is an Object.prototype key is not a §10 refusal', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'refuse', refuseWith: { status: 502, error: 'constructor' } };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('uncertain');
    expect(entries(w.dataDir)[0].state).toBe('uncertain');
  });

  // INV-14: "A requestId is never paid twice". INV-19: "concurrent processes share one lock".
  // Two processes (two clients on one dataDir) run the same call with the same buyer-chosen requestId.
  // The requestId uniqueness check (client.ts, before V1) is outside the V6 lock, so both reserve,
  // both sign, and the ledger ends with two records under one requestId.
  it('two processes with the same requestId never both sign, and the ledger keeps one record per requestId', async () => {
    w = await makeWorld({ waitForExpiry: false });
    const requestId = keccak256(stringToBytes(`adv-${Math.random()}`)) as Hex;
    const other = w.mkClient();
    const [a, b] = await Promise.all([
      w.client.payAndVerify(w.url, { body: w.body, requestId }),
      other.payAndVerify(w.url, { body: w.body, requestId }),
    ]);
    const ids = entries(w.dataDir).map((e: { requestId: string }) => e.requestId);
    const settled = w.gw.paid.length;
    // Diagnostics for the report.
    console.log(JSON.stringify({ a: [a.outcome, a.code, a.check], b: [b.outcome, b.code, b.check], signatures: w.transferSignatures(), settled, ids, spend: spendToday(entries(w.dataDir), w.chain.asset, Date.now()).toString() }));
    expect(w.transferSignatures()).toBeLessThanOrEqual(1);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
