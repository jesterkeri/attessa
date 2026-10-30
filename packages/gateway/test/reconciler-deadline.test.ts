import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

describe('reconciler: INV-11 deadline for a row settled late (SPEC §6.3)', () => {
  it('the log index shows the tx only at validBefore + 58: the row is delivery_failed in that same check, still served', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500 }, { kind: 'status', status: 500, broadcast: true }];
    const p = await h.pay({ validBefore: h.clock.t + 60 });
    const r = await h.call(p);
    expect(r.statusCode).toBe(202);
    const id = r.headers['x-request-id'] as string;

    h.chain.logLag = 65n; // the tx mined at validBefore - 7 is visible to getLogs from validBefore + 58
    h.chain.advance(p.validBefore - 7 - h.clock.t);
    await h.gw.reconciler.tick(); // the re-send broadcasts
    for (let t = p.validBefore - 2; t <= p.validBefore + 53; t += 5) {
      h.chain.advance(5);
      await h.gw.reconciler.tick();
      expect(h.row(id)!.state).toBe('settle_pending');
    }
    h.chain.advance(5);
    expect(h.clock.t).toBe(p.validBefore + 58);
    await h.gw.reconciler.tick();
    const row = h.row(id)!;
    expect(row).toMatchObject({ state: 'delivery_failed', updated_at: p.validBefore + 58 });
    expect(row.settle_tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await h.results(id)).statusCode).toBe(200);
  });

  it('a settled row whose handler is still live is not swept past the deadline', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 503, broadcast: true }];
    const p = await h.pay({ validBefore: h.clock.t + 60 });
    const id = (await h.call(p)).headers['x-request-id'] as string;
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled');
    h.gw.live.add(id); // a handler still writing the response
    h.chain.advance(p.validBefore + 55 - h.clock.t);
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled');
    h.gw.live.delete(id);
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('delivery_failed');
  });
});
