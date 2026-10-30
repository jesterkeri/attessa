import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

/** One paid call whose handler send gets a 5xx and broadcasts, so the reconciler settles it after the 202. */
async function settledByReconciler(validBeforeIn: number): Promise<{ id: string; validBefore: number }> {
  h.fac.settleScript = [{ kind: 'status', status: 503, broadcast: true }];
  const p = await h.pay({ validBefore: h.clock.t + validBeforeIn });
  const r = await h.call(p);
  expect(r.statusCode).toBe(202);
  const id = r.headers['x-request-id'] as string;
  await h.gw.reconciler.tick();
  expect(h.row(id)!.state).toBe('settled');
  return { id, validBefore: p.validBefore };
}

describe('adversary T19 r5: delivery grace across a restart (SPEC §6.3, INV-11)', () => {
  it('settled with no live response for 35 s across a restart: the restarted gateway makes it delivery_failed', async () => {
    h = await makeHarness();
    const { id } = await settledByReconciler(300); // far from validBefore: only the 30 s grace applies
    const settledAt = h.row(id)!.updated_at;
    expect(h.gw.live.has(id)).toBe(false); // the handler answered 202 and left; nothing is delivering it

    h.chain.advance(25);
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled'); // 25 s: inside the grace

    // The process restarts. A new process has no live handler for any row.
    await h.restart();
    h.chain.advance(settledAt + 35 - h.clock.t);
    await h.gw.start(); // startup sweep + first pass
    await h.gw.reconciler.tick();

    // SPEC §6.3: "`settled` with no live response for > 30 s → `delivery_failed`". 35 s have passed.
    expect({ state: h.row(id)!.state, secondsWithoutLiveResponse: h.clock.t - settledAt }).toEqual({
      state: 'delivery_failed',
      secondsWithoutLiveResponse: 35,
    });
  });

  it('a restart with a settled row past validBefore + 50: the startup pass finishes it', async () => {
    h = await makeHarness();
    const { id, validBefore } = await settledByReconciler(60);
    await h.restart();
    h.chain.advance(validBefore + 51 - h.clock.t);
    await h.gw.start();
    expect(h.row(id)!.state).toBe('delivery_failed');
  });
});
