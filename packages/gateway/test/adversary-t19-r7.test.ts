import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpFacilitator } from '../src/facilitator.ts';
import { createGateway, type Gateway } from '../src/gateway.ts';
import { makeHarness, type Harness } from './fakes/harness.ts';

let h: Harness;
let g: Gateway | null = null;
afterEach(async () => {
  await g?.close();
  g = null;
  await h?.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('adversary T19 r7: the paying client hangs up during execution, before the settle (SPEC §6.3, INV-11)', () => {
  it('the row the handler then settles is still finished by validBefore + 60 s', async () => {
    h = await makeHarness();
    h.seller.tamper = { delayMs: 300 }; // the enclave takes 300 ms (executeMs is 400)
    const p = await h.pay({ validBefore: h.clock.t + 120 });

    g = createGateway({
      cfg: h.cfg,
      db: h.db,
      chain: h.chain,
      facilitator: new HttpFacilitator(h.cfg.facilitatorUrl, undefined),
      sellerHost: h.seller,
      now: h.clock.now,
      log: () => {},
    });
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
    for (let i = 0; i < 200 && h.rows()[0]?.state !== 'executing'; i++) await wait(5);
    const id = h.rows()[0]!.request_id;
    expect(h.row(id)!.state).toBe('executing');

    // The client gives up while the enclave is still working (a client-side timeout).
    req.destroy();

    // Execution, proof check, persist and settle go through: the row is `settled`, nobody is left to deliver to.
    for (let i = 0; i < 200 && ['executing', 'settling'].includes(h.row(id)!.state); i++) await wait(10);
    await wait(100);
    expect(h.row(id)!.settle_tx).not.toBeNull();

    // The reconciler runs every 5 s up to validBefore + 60 s.
    while (h.clock.t + 5 <= p.validBefore + 60) {
      h.chain.advance(5);
      await g.reconciler.tick();
    }
    const row = h.row(id)!;
    // INV-11: terminal by validBefore + 60 s. Nothing is delivering this row.
    expect({ state: row.state, liveHandler: g.live.has(id) }).toEqual({ state: 'delivery_failed', liveHandler: false });
  });
});
