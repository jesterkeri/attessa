import { afterEach, describe, expect, it } from 'vitest';
import { b64json, makeHarness, type Harness } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

describe('smoke', () => {
  it('quote then paid call', async () => {
    h = await makeHarness();
    const q = await h.quote();
    expect(q.statusCode).toBe(402);
    const p = await h.pay();
    const r = await h.call(p);
    expect(r.statusCode).toBe(200);
    expect(h.fac.settleCalls).toBe(1);
    expect(h.rows()[0]?.state).toBe('delivered');
    expect(b64json(r.headers['payment-response'])).toMatchObject({ success: true, network: 'eip155:11142220', payer: h.buyer });
  });
});
