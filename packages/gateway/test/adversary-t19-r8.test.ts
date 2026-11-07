import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpFacilitator } from '../src/facilitator.ts';
import { createGateway, type Gateway } from '../src/gateway.ts';
import { makeHarness, type Harness, type Payment } from './fakes/harness.ts';

let h: Harness;
let g: Gateway | null = null;
afterEach(async () => {
  await g?.close();
  g = null;
  await h?.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rawEvaluate(p: Payment, body: string): string {
  return (
    'POST /v1/evaluate HTTP/1.1\r\nHost: risk.example\r\nContent-Type: application/json\r\n' +
    `Payment-Signature: ${p.header}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

describe('adversary T19 r8: two pipelined paid calls on one HTTP/1.1 connection, the client hangs up (SPEC §6.3, INV-11)', () => {
  it('both rows the handlers then settle are finished by validBefore + 60 s', async () => {
    h = await makeHarness();
    h.seller.tamper = { delayMs: 300 }; // the enclave takes 300 ms (executeMs is 400)
    const p1 = await h.pay({ validBefore: h.clock.t + 120 });
    const p2 = await h.pay({ validBefore: h.clock.t + 120 });

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

    // One connection carries both requests back to back (HTTP/1.1 pipelining); Node runs both handlers.
    const s = connect(port, '127.0.0.1');
    s.on('error', () => {});
    await new Promise<void>((r) => s.once('connect', () => r()));
    s.write(rawEvaluate(p1, h.body) + rawEvaluate(p2, h.body));
    for (let i = 0; i < 200 && h.rows().filter((r) => r.state === 'executing').length < 2; i++) await wait(5);
    expect(h.rows().map((r) => r.state)).toEqual(['executing', 'executing']);

    // The client hangs up while both are executing.
    s.destroy();

    // Both handlers execute, persist and settle: two `settled` rows, nobody left to deliver to.
    for (let i = 0; i < 200 && h.rows().some((r) => ['executing', 'settling'].includes(r.state)); i++) await wait(10);
    await wait(100);
    expect(h.rows().every((r) => r.settle_tx !== null)).toBe(true);

    while (h.clock.t + 5 <= p1.validBefore + 60) {
      h.chain.advance(5);
      await g.reconciler.tick();
    }
    // INV-11: every row terminal by validBefore + 60 s.
    expect(h.rows().map((r) => ({ state: r.state, liveHandler: g!.live.has(r.request_id) }))).toEqual([
      { state: 'delivery_failed', liveHandler: false },
      { state: 'delivery_failed', liveHandler: false },
    ]);
  });
});
