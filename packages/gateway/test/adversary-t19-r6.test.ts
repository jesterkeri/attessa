import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpFacilitator, type Facilitator } from '../src/facilitator.ts';
import { createGateway, type Gateway } from '../src/gateway.ts';
import { makeHarness, type Harness } from './fakes/harness.ts';

let h: Harness;
let g: Gateway | null = null;
let release: () => void = () => {};
afterEach(async () => {
  release();
  await g?.close();
  g = null;
  await h?.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('adversary T19 r6: the paying client hangs up while the handler waits for /settle (SPEC §6.3, INV-11)', () => {
  it('the row the handler then settles is still finished by validBefore + 60 s', async () => {
    h = await makeHarness();
    const p = await h.pay({ validBefore: h.clock.t + 120 });

    // A gateway on a real socket whose first /settle is held until the test releases it.
    const held = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const settleReached = new Promise<void>((r) => (reached = r));
    const inner = new HttpFacilitator(h.cfg.facilitatorUrl, undefined);
    const facilitator: Facilitator = {
      verify: (r, t) => inner.verify(r, t),
      supported: (t) => inner.supported(t),
      settle: async (r, t) => {
        reached();
        await held;
        return inner.settle(r, t);
      },
    };
    g = createGateway({ cfg: h.cfg, db: h.db, chain: h.chain, facilitator, sellerHost: h.seller, now: h.clock.now, log: () => {} });
    await g.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (g.app.server.address() as AddressInfo).port;

    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/evaluate',
      headers: { 'content-type': 'application/json', 'payment-signature': p.header },
    });
    req.on('error', () => {}); // the client hangs up below
    req.end(h.body);
    await settleReached;
    const id = h.rows()[0]!.request_id;
    expect(h.row(id)!.state).toBe('settling');

    // The client gives up while the settle is in flight (a client-side timeout).
    req.destroy();
    await wait(100);

    // The settle goes through: the handler moves the row to `settled` and tries to deliver to a closed socket.
    release();
    for (let i = 0; i < 100 && h.row(id)!.state === 'settling'; i++) await wait(10);
    await wait(100);
    expect(h.row(id)!.state).not.toBe('settling');

    // The reconciler runs every 5 s up to validBefore + 60 s.
    while (h.clock.t + 5 <= p.validBefore + 60) {
      h.chain.advance(5);
      await g.reconciler.tick();
    }
    const row = h.row(id)!;
    // INV-11: terminal by validBefore + 60 s. Nothing is delivering this row any more.
    expect({ state: row.state, liveHandler: g.live.has(id) }).toEqual({ state: 'delivery_failed', liveHandler: false });
  });
});
