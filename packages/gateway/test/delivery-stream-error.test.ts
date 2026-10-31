import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
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

describe('the response stream fails after the headers are written (SPEC §6.2 step 12, §6.3)', () => {
  it('the row is delivery_failed and no live mark is left', async () => {
    h = await makeHarness();
    const p = await h.pay();
    g = createGateway({
      cfg: h.cfg,
      db: h.db,
      chain: h.chain,
      facilitator: new HttpFacilitator(h.cfg.facilitatorUrl, undefined),
      sellerHost: h.seller,
      now: h.clock.now,
      log: () => {},
    });
    // The 200's body becomes a stream that writes a first chunk (so the headers go out), then errors.
    g.app.addHook('onSend', async (_req, reply, payload) => {
      if (reply.statusCode !== 200) return payload;
      const bytes = Buffer.from(payload as Buffer);
      let sent = false;
      return new Readable({
        read() {
          if (!sent) {
            sent = true;
            this.push(bytes.subarray(0, 8));
          } else setTimeout(() => this.destroy(new Error('disk gone')), 20);
        },
      });
    });
    await g.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (g.app.server.address() as AddressInfo).port;

    const status = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/evaluate',
        headers: { 'content-type': 'application/json', 'payment-signature': p.header },
      });
      req.on('response', (m) => {
        resolve(m.statusCode ?? 0);
        m.on('data', () => {});
        m.on('error', () => {});
      });
      req.on('error', reject);
      req.end(h.body);
    });
    expect(status).toBe(200); // the headers were written

    const id = h.rows()[0]!.request_id;
    for (let i = 0; i < 100 && h.row(id)!.state === 'settled'; i++) await new Promise((r) => setTimeout(r, 10));
    expect({ state: h.row(id)!.state, liveHandler: g.live.has(id) }).toEqual({ state: 'delivery_failed', liveHandler: false });
  });
});
