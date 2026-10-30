import { afterEach, describe, expect, it } from 'vitest';
import { TERMINAL_STATES } from '../src/db.ts';
import { makeHarness, type Harness } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

describe('adversary T19 r4: INV-11 for a row the reconciler settles late', () => {
  it('a re-send lands at validBefore - 7 and the log index lags 40 s: the row is terminal by validBefore + 60 s', async () => {
    h = await makeHarness();
    // The handler's send gets a 5xx and the reconciler's re-sends too, until one broadcasts close to validBefore.
    h.fac.settleScript = [{ kind: 'status', status: 500 }, { kind: 'status', status: 500, broadcast: true }];
    const p = await h.pay({ validBefore: h.clock.t + 60 });
    const r = await h.call(p);
    expect(r.statusCode).toBe(202);
    const id = r.headers['x-request-id'] as string;
    expect(h.row(id)!.state).toBe('settle_pending');

    // A lagging log index (INV-11 "lagging RPC"): logs of the newest 40 blocks (1 block per second) are hidden.
    h.chain.logLag = 40n;
    h.chain.advance(p.validBefore - 7 - h.clock.t);
    await h.gw.reconciler.tick(); // this re-send broadcasts: the tx lands at validBefore - 7
    expect(h.chain.isUsed(p.accepted.asset, h.buyer, p.nonce)).toBe(true);

    // The reconciler runs every 5 s (SPEC §6.3) up to validBefore + 60 s.
    while (h.clock.t + 5 <= p.validBefore + 60) {
      h.chain.advance(5);
      await h.gw.reconciler.tick();
    }
    h.chain.advance(p.validBefore + 60 - h.clock.t);
    await h.gw.reconciler.tick();
    expect(h.clock.t).toBe(p.validBefore + 60);

    const row = h.row(id)!;
    expect(row.settle_tx).not.toBeNull(); // the payment did settle, from chain evidence
    expect(row.updated_at).toBe(p.validBefore + 33); // first pass whose log query shows the tx; no live handler since the 202
    // INV-11: every row reaches a terminal state by validBefore + 60 s.
    expect({ state: row.state, terminal: TERMINAL_STATES.includes(row.state) }).toEqual({ state: 'delivery_failed', terminal: true });
  });
});
