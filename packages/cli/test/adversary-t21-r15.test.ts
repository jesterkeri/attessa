import { afterEach, describe, expect, it } from 'vitest';
import { AlreadyUsedError } from '../../sdk/src/client.ts';
import { makeWorld, type World } from '../../sdk/test/fakes/world.ts';

// T21 adversary r15. getResult now ends a settled call terminally on the gateway's own §10 `result_not_found`. But the
// gateway answers that same 404 when the buyer's `X-Attest-Payer-Sig` timestamp is more than 300 s from gateway time
// (SPEC §2.5 "Accepted within 300 s of gateway time"; packages/gateway/src/gateway.ts, results route: a stale
// signature returns notFound()). The SDK stamps that signature with its RPC's `latest` block time, so an RPC that is
// more than 5 minutes behind makes the gateway say "no result" for a call whose answer it holds and serves.
// SPEC §7 "refused / uncertain -> final": settled on chain, "first call getResult: a result that passes V10 ->
// verified". INV-13: a result fetched hours after settlement still verifies. FLOWS §7: Uncertain -> PaidButRejected
// only when "settled but no valid result retrievable". The answer here is retrievable the moment the RPC catches up,
// yet the call is already terminal paid_but_rejected{missing_proof}, with a false evidence row, and V12 means it is
// never fetched again.

let w: World;
afterEach(async () => w?.close());

describe('getResult through an RPC 6 minutes behind, on an uncertain call whose answer the gateway holds', () => {
  it('stays undecided, and verifies once the RPC catches up (never a permanent paid_but_rejected{missing_proof})', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'drop_after_settle' }; // settles and stores a valid answer, then drops the socket
    const r0 = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r0.outcome).toBe('uncertain');
    // The chain shows the settlement: the SDK records its tx (cancelAuthorization's AlreadyUsedError path).
    const err = await w.client.cancelAuthorization(r0.requestId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlreadyUsedError);

    // Ten minutes on, the buyer's RPC reports a `latest` block 6 minutes old.
    w.chain.advance(600);
    w.chain.headLag = 360;
    const r1 = await w.client.getResult(r0.requestId);
    expect(r1.outcome).not.toBe('paid_but_rejected');

    // The RPC catches up. The gateway still holds the answer that verifies.
    w.chain.headLag = 0;
    const r2 = await w.client.getResult(r0.requestId);
    expect(r2.outcome).toBe('verified');
  });
});
