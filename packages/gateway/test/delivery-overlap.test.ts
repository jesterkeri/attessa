import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpFacilitator } from '../src/facilitator.ts';
import { createGateway, type Gateway } from '../src/gateway.ts';
import { makeHarness, type Harness, type Payment } from './fakes/harness.ts';

let h: Harness;
let g: Gateway | null = null;
let releaseAll: () => void = () => {};
afterEach(async () => {
  releaseAll(); // a failed assertion must not leave a held response blocking close
  await g?.close();
  g = null;
  await h?.close();
});

/**
 * A gateway on a real socket whose response writes wait for the test: a request carrying `x-test-hold: <tag>`
 * stops in onSend (after the handler chose its answer, before any byte is written) until `release(tag)`.
 */
async function heldGateway(): Promise<{ port: number; reached: (tag: string) => Promise<void>; release: (tag: string) => void }> {
  const gates = new Map<string, { reached: () => void; reachedP: Promise<void>; release: () => void; releaseP: Promise<void> }>();
  const gate = (tag: string) => {
    let e = gates.get(tag);
    if (!e) {
      let reached!: () => void;
      let release!: () => void;
      const reachedP = new Promise<void>((r) => (reached = r));
      const releaseP = new Promise<void>((r) => (release = r));
      e = { reached, reachedP, release, releaseP };
      gates.set(tag, e);
    }
    return e;
  };
  releaseAll = () => gates.forEach((e) => e.release());
  g = createGateway({
    cfg: h.cfg,
    db: h.db,
    chain: h.chain,
    facilitator: new HttpFacilitator(h.cfg.facilitatorUrl, undefined),
    sellerHost: h.seller,
    now: h.clock.now,
    log: () => {},
  });
  g.app.addHook('onSend', async (req, _reply, payload) => {
    const tag = req.headers['x-test-hold'];
    if (typeof tag === 'string') {
      gate(tag).reached();
      await gate(tag).releaseP;
    }
    return payload;
  });
  await g.app.listen({ host: '127.0.0.1', port: 0 });
  return {
    port: (g.app.server.address() as AddressInfo).port,
    reached: (tag) => gate(tag).reachedP,
    release: (tag) => gate(tag).release(),
  };
}

function send(port: number, p: Payment, tag: string): { req: ClientRequest; res: Promise<{ status: number; body: string }> } {
  const req = request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/v1/evaluate',
    headers: { 'content-type': 'application/json', 'payment-signature': p.header, 'x-test-hold': tag },
  });
  const res = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on('response', (m: IncomingMessage) => {
      const chunks: Buffer[] = [];
      m.on('data', (c: Buffer) => chunks.push(c));
      m.on('end', () => resolve({ status: m.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      m.on('error', reject);
    });
    req.on('error', reject);
  });
  req.end(h.body);
  return { req, res };
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe('two overlapping deliveries of one settled row (SPEC §6.2 step 12, §6.3)', () => {
  it('the first client leaves, the duplicate request receives the result: the row ends delivered', async () => {
    h = await makeHarness();
    const p = await h.pay();
    const s = await heldGateway();

    // A: the paying request settles and stops just before writing its 200.
    const a = send(s.port, p, 'a');
    a.res.catch(() => {}); // A's client hangs up below
    await s.reached('a');
    const id = h.rows()[0]!.request_id;
    expect(h.row(id)!.state).toBe('settled');

    // B: the same request with the same payment while A is still delivering (SPEC §6.2 step 4: 200 stored result).
    const b = send(s.port, p, 'b');
    await s.reached('b');

    // A's client leaves before its response is written.
    a.req.destroy();
    await new Promise((r) => setTimeout(r, 100)); // let the server see A's socket close
    s.release('a');

    // B is still delivering: its row is not failed under it, and the reconciler does not sweep it either.
    h.chain.advance(31);
    await g!.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled');

    s.release('b');
    const rb = await b.res;
    expect(rb.status).toBe(200);
    expect(rb.body).toContain('verdict');
    await until(() => h.row(id)!.state !== 'settled');
    expect(h.row(id)!.state).toBe('delivered');
  });

  it('both clients leave: the row ends delivery_failed', async () => {
    h = await makeHarness();
    const p = await h.pay();
    const s = await heldGateway();
    const a = send(s.port, p, 'a');
    a.res.catch(() => {});
    await s.reached('a');
    const id = h.rows()[0]!.request_id;
    const b = send(s.port, p, 'b');
    b.res.catch(() => {});
    await s.reached('b');
    a.req.destroy();
    b.req.destroy();
    await until(() => h.row(id)!.state !== 'settled');
    expect(h.row(id)!.state).toBe('delivery_failed');
    s.release('a');
    s.release('b');
  });
});
