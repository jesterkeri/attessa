import { afterEach, describe, expect, it } from 'vitest';
import type { Facilitator } from '../src/facilitator.ts';
import { makeHarness, type Harness } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('adversary T19 r3: a row check works from the row as read at the start of the pass (SPEC §6.3 step 5, INV-9)', () => {
  it('the handler settles the row while a reconciler check is reading logs: the check sends no /settle for the settled row', async () => {
    // The handler's own send is held before it reaches the facilitator (as if a 429 backoff kept it
    // in flight past 20 s); it is released while the reconciler check of the same row is mid-RPC.
    let releaseHandler!: () => void;
    const handlerHeld = new Promise<void>((r) => (releaseHandler = r));
    let handlerSends = 0;
    h = await makeHarness({
      wrapFacilitator: (f: Facilitator): Facilitator => ({
        verify: (r, t) => f.verify(r, t),
        supported: (t) => f.supported(t),
        settle: async (r, t) => {
          if (handlerSends++ === 0) await handlerHeld;
          return f.settle(r, t);
        },
      }),
    });

    const p = await h.pay({ validBefore: h.clock.t + 300 });
    const call = h.call(p);
    let id = '';
    for (let i = 0; i < 200 && !id; i++) {
      await wait(5);
      const r = h.rows().find((x) => x.state === 'settling');
      if (r) id = r.request_id;
    }
    expect(id).not.toBe('');
    expect(h.gw.sending.has(id)).toBe(true);

    // The row's send has been in flight for more than 20 s.
    h.clock.t += 25;

    // The reconciler's AuthorizationUsed query runs now (nothing on chain yet) but its answer arrives late.
    let releaseLogs!: () => void;
    const logsHeld = new Promise<void>((r) => (releaseLogs = r));
    const realGetLogs = h.chain.getLogs.bind(h.chain);
    let firstLogs = true;
    h.chain.getLogs = async (...a: Parameters<typeof realGetLogs>) => {
      const out = await realGetLogs(...a);
      if (firstLogs) {
        firstLogs = false;
        await logsHeld;
      }
      return out;
    };
    const tick = h.gw.reconciler.tick();
    await wait(20);

    // Meanwhile the handler's send goes through, the receipt is found, and the row is `settled`.
    releaseHandler();
    const res = await call;
    expect(res.statusCode).toBe(200);
    expect(h.row(id)!.state).toMatch(/^(settled|delivered)$/);
    expect(h.gw.sending.has(id)).toBe(false);
    expect(h.fac.settleCalls).toBe(1);

    // The check resumes with the empty log answer it read before the tx landed.
    releaseLogs();
    await tick;
    await h.gw.reconciler.tick();

    // SPEC §6.3 step 5 re-sends only `settle_pending` rows or `settling` rows older than 20 s; this row was
    // `settled` when the check reached step 5. Done-when: 0 extra settles in all.
    expect(h.fac.settleCalls).toBe(1);
  });
});
