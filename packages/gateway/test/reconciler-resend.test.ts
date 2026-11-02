import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One paid call whose handler send gets a 5xx, so the row is `settle_pending` for the reconciler. */
async function pendingRow(validBeforeIn = 300): Promise<{ id: string; validBefore: number }> {
  const p = await h.pay({ validBefore: h.clock.t + validBeforeIn });
  const r = await h.call(p);
  expect(r.statusCode).toBe(202);
  const id = r.headers['x-request-id'] as string;
  expect(h.row(id)!.state).toBe('settle_pending');
  return { id, validBefore: p.validBefore };
}

describe('reconciler re-sends (SPEC §6.3 step 5, INV-11)', () => {
  it('a hanging re-send neither holds up the next pass nor is sent twice; expiry still lands, and the late answer is not recorded', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500 }, { kind: 'hang' }, ...Array(10).fill({ kind: 'status', status: 500 })];
    const { id, validBefore } = await pendingRow();
    expect(h.fac.settleCalls).toBe(1);

    const first = h.gw.reconciler.tick(); // starts a re-send that hangs until the 400 ms settle timeout
    await wait(50);
    expect(h.fac.settleCalls).toBe(2);

    // The next pass runs at once (it returns while the re-send is still unanswered) and does not send
    // that row again while its re-send is in flight.
    await h.gw.reconciler.tick();
    expect(h.row(id)!.reject_reason).not.toBe('timeout');
    expect(h.fac.settleCalls).toBe(2);

    // Chain evidence still terminalizes the row while the re-send hangs.
    h.chain.advance(validBefore + 6 - h.clock.t);
    await h.gw.reconciler.tick();
    expect(h.row(id)!).toMatchObject({ state: 'settle_failed', reject_reason: 'expired', payment_payload: null });

    // The re-send then times out; its answer never overwrites the terminal outcome.
    await first;
    expect(h.row(id)!).toMatchObject({ state: 'settle_failed', reject_reason: 'expired' });
    expect(h.fac.settleCalls).toBe(2);
  });

  it('a re-send whose first attempt lands late: the row settles from chain evidence and the late answer keeps the recorded tx', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500 }, { kind: 'hang', landAfterMs: 30 }];
    const { id } = await pendingRow();

    const first = h.gw.reconciler.tick(); // broadcasts after 30 ms, then never answers
    await wait(100);
    await h.gw.reconciler.tick();
    const settled = h.row(id)!;
    expect(settled).toMatchObject({ state: 'settled', reject_reason: null });
    expect(settled.settle_tx).toMatch(/^0x[0-9a-f]{64}$/);

    await first; // the re-send times out
    expect(h.row(id)!).toMatchObject({ state: 'settled', reject_reason: null, settle_tx: settled.settle_tx });
  });

  it('stop() waits for a re-send in flight, so nothing is written after close', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500 }, { kind: 'hang' }];
    const { id } = await pendingRow();
    void h.gw.reconciler.tick();
    await wait(50);
    expect(h.row(id)!.reject_reason).not.toBe('timeout');
    await h.gw.reconciler.stop();
    expect(h.row(id)!).toMatchObject({ state: 'settle_pending', reject_reason: 'timeout' });
  });
});
