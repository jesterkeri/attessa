import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpFacilitator } from '../src/facilitator.ts';
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

describe('a duplicate request for a settled row whose client leaves before it is answered (SPEC §6.2 step 4, §6.3, INV-11)', () => {
  it('the row is still finished by validBefore + 60 s and no live mark is left', async () => {
    h = await makeHarness();
    // The paying request ends 202 (5xx that broadcasts); the reconciler settles the row; nobody is delivering it.
    h.fac.settleScript = [{ kind: 'status', status: 503, broadcast: true }];
    const p = await h.pay({ validBefore: h.clock.t + 120 });
    const r = await h.call(p);
    expect(r.statusCode).toBe(202);
    const id = r.headers['x-request-id'] as string;
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled');

    // A gateway on a real socket that holds a request before its handler runs (standing in for any wait
    // before the handler takes the row: the lock, recoverAuthorizationSigner, a slow event loop).
    const held = new Promise<void>((res) => (release = res));
    let reached!: () => void;
    const handlerReached = new Promise<void>((res) => (reached = res));
    g = createGateway({
      cfg: h.cfg,
      db: h.db,
      chain: h.chain,
      facilitator: new HttpFacilitator(h.cfg.facilitatorUrl, undefined),
      sellerHost: h.seller,
      now: h.clock.now,
      log: () => {},
    });
    g.app.addHook('preHandler', async () => {
      reached();
      await held;
    });
    await g.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (g.app.server.address() as AddressInfo).port;

    // The duplicate request: same request, same payment (SPEC §6.2 step 4: 200 stored result).
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/evaluate',
      headers: { 'content-type': 'application/json', 'payment-signature': p.header },
    });
    req.on('error', () => {});
    req.end(h.body);
    await handlerReached;
    req.destroy(); // the client leaves before the handler answers
    await wait(100);
    release();
    await wait(200);

    while (h.clock.t + 5 <= p.validBefore + 60) {
      h.chain.advance(5);
      await g.reconciler.tick();
    }
    expect({ state: h.row(id)!.state, liveHandler: g.live.has(id) }).toEqual({ state: 'delivery_failed', liveHandler: false });
  });
});
