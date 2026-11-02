import { authorizationTopics } from '../src/chain.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { b64json, makeHarness, type Harness, type Payment } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

type Res = Awaited<ReturnType<Harness['call']>>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function expectPending(r: Res): string {
  expect(r.statusCode).toBe(202);
  expect(r.json()).toMatchObject({ error: 'settle_pending', suggestion: 'poll_results' });
  expect(r.headers['retry-after']).toBe('3');
  expect(r.headers['x-attested-proof']).toBeUndefined();
  expect(r.body).not.toContain('verdict');
  const id = r.headers['x-request-id'] as string;
  expect(h.row(id)!.state).toBe('settle_pending');
  return id;
}

/** Number of on-chain uses of this payment's authorization: at most one, ever. */
async function usesOf(p: Payment): Promise<number> {
  const asset = p.accepted.asset;
  return (await h.chain.getLogs(asset, authorizationTopics('AuthorizationUsed', h.buyer, p.nonce), 0n)).length;
}

describe('settlement keyed on HTTP status (SPEC §6.2 step 11)', () => {
  for (const status of [400, 412]) {
    it(`${status} → settle_pending with the reason, 202 + Retry-After 3; authorizationState is not read`, async () => {
      h = await makeHarness();
      h.fac.settleScript = [{ kind: 'status', status, body: { success: false, errorReason: 'insufficient_funds', transaction: '', network: 'eip155:11142220' } }];
      const r = await h.call(await h.pay());
      const id = expectPending(r);
      expect(h.row(id)!.reject_reason).toBe('insufficient_funds');
      expect(r.headers['payment-response']).toBeUndefined();
      expect(h.chain.calls.authorizationState).toBe(0);
      expect(h.fac.settleCalls).toBe(1);
    });
  }

  it('2xx success:false → settle_pending', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 200, body: { success: false, errorReason: 'unexpected_settle_error' } }];
    expectPending(await h.call(await h.pay()));
  });

  it('2xx success:true whose receipt lacks the Transfer → settle_pending (then expired, never settled)', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'successWithoutTransfer' }, ...Array(200).fill({ kind: 'status', status: 500 })];
    const p = await h.pay();
    const r = await h.call(p);
    const id = expectPending(r);
    expect(h.row(id)!.reject_reason).toBe('receipt_without_settlement');
    // The tx hash is known, so PAYMENT-RESPONSE is present on the 202.
    expect(b64json(r.headers['payment-response'])).toMatchObject({ success: false, transaction: h.row(id)!.settle_tx });
    h.chain.advance(p.validBefore - h.clock.t + 6);
    await h.gw.reconciler.tick();
    expect(h.row(id)!).toMatchObject({ state: 'settle_failed', reject_reason: 'expired' });
  });

  it('error after broadcast (500) → 202, then the reconciler finds the tx → settled, served by /v1/results', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500, broadcast: true, body: { error: 'unexpected_error' } }];
    const p = await h.pay();
    const id = expectPending(await h.call(p));
    expect((await h.results(id)).statusCode).toBe(202);
    await h.gw.reconciler.tick();
    const row = h.row(id)!;
    expect(row.state).toBe('settled');
    expect(row.settle_tx).toMatch(/^0x[0-9a-f]{64}$/);
    const res = await h.results(id);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(Buffer.from(row.response!))).toBe(true);
    expect(res.headers['x-attested-proof']).toBe(row.proof_header);
    expect(b64json(res.headers['payment-response'])).toMatchObject({ success: true, transaction: row.settle_tx });
    expect(h.fac.settleCalls).toBe(1);
    expect(await usesOf(p)).toBe(1);
  });

  it('first settle times out, the tx lands at +16 s, the retry returns 400 → the row ends settled, never settle_failed', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'hang', landAfterMs: 500 }];
    h.chain.logLag = 10_000n;
    const p = await h.pay();
    const id = expectPending(await h.call(p));
    expect(h.row(id)!.reject_reason).toBe('timeout');
    await wait(200);
    expect(await h.chain.authorizationState(p.accepted.asset, h.buyer, p.nonce, h.chain.head().number)).toBe(true);
    h.chain.advance(16);
    await h.gw.reconciler.tick(); // log index behind: retry from the stored payload, which answers 400
    expect(h.fac.settleCalls).toBe(2);
    expect(h.row(id)!).toMatchObject({ state: 'settle_pending', reject_reason: 'invalid_transaction_state' });
    h.chain.logLag = 0n;
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled');
    expect((await h.results(id)).statusCode).toBe(200);
    expect(await usesOf(p)).toBe(1);
  });

  it('handler 400 with stale authorizationState == false, then the matching receipt → settle_pending → settled, result served', async () => {
    h = await makeHarness();
    // The facilitator broadcast and answered 400; the node the gateway reads still says unused (lagging).
    h.fac.settleScript = [{ kind: 'status', status: 400, broadcast: true, body: { success: false, errorReason: 'invalid_transaction_state' } }];
    h.chain.logLag = 10_000n;
    const p = await h.pay();
    const stale = h.chain.authorizationState.bind(h.chain);
    h.chain.authorizationState = async () => false;
    const id = expectPending(await h.call(p));
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settle_pending');
    h.chain.authorizationState = stale;
    h.chain.logLag = 0n;
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled');
    expect((await h.results(id)).statusCode).toBe(200);
    expect(await usesOf(p)).toBe(1);
  });

  it('429 → retried after Retry-After while the window allows → settled', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 429, retryAfter: 1, body: {} }];
    const t0 = performance.now();
    const r = await h.call(await h.pay());
    expect(r.statusCode).toBe(200);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(950);
    expect(h.fac.settleCalls).toBe(2);
  });

  it('429 when waiting would leave < 10 s → settle_pending without a re-send', async () => {
    h = await makeHarness();
    const p = await h.pay({ validBefore: h.clock.t + 45 });
    h.seller.tamper = { before: () => h.chain.advance(35) }; // validBefore − now = 10 at step 10
    h.fac.settleScript = [{ kind: 'status', status: 429, retryAfter: 1, body: {} }];
    const id = expectPending(await h.call(p));
    expect(h.row(id)!.reject_reason).toBe('rate_limited');
    expect(h.fac.settleCalls).toBe(1);
  });

  for (const status of [401, 402]) {
    it(`${status} → settle_pending, paused, logged; new calls 503; the reconciler doesn't re-send while paused`, async () => {
      h = await makeHarness();
      h.fac.settleScript = [{ kind: 'status', status, body: {} }];
      const id = expectPending(await h.call(await h.pay()));
      expect(h.db.isPaused()).toBe(true);
      expect(h.logs.some((l) => l.event === 'facilitator_auth_or_credit')).toBe(true);
      const next = await h.quote();
      expect(next.statusCode).toBe(503);
      expect(next.json().error).toBe('gateway_paused');
      h.chain.advance(30);
      await h.gw.reconciler.tick();
      expect(h.fac.settleCalls).toBe(1);
      expect(h.row(id)!.state).toBe('settle_pending');
    });
  }

  it('receipt not yet served within the poll → settle_pending with the tx; PAYMENT-RESPONSE carries it', async () => {
    h = await makeHarness();
    h.chain.receiptLag = 1000n;
    const r = await h.call(await h.pay());
    const id = expectPending(r);
    expect(h.row(id)!.reject_reason).toBe('receipt_not_found');
    expect(b64json(r.headers['payment-response']).transaction).toBe(h.row(id)!.settle_tx);
    expect(r.json().message).toContain(`(tx ${h.row(id)!.settle_tx})`);
    h.chain.receiptLag = 0n;
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled');
  });
});

describe('reconciler (SPEC §6.3, INV-11)', () => {
  it('front-run nonce with value 0 to self → settle_failed{nonce_used_elsewhere}, result withheld', async () => {
    h = await makeHarness();
    const p = await h.pay();
    h.seller.tamper = { before: () => void h.chain.transferWithAuthorization(p.accepted.asset, h.buyer, h.buyer, 0n, p.nonce) };
    const id = expectPending(await h.call(p));
    await h.gw.reconciler.tick();
    const row = h.row(id)!;
    expect(row).toMatchObject({ state: 'settle_failed', reject_reason: 'nonce_used_elsewhere', payment_payload: null, response: null });
    const res = await h.results(id);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('verdict');
    const again = await h.call(p);
    expect(again.statusCode).toBe(502);
    expect(again.json()).toMatchObject({ error: 'settle_failed', detail: 'nonce_used_elsewhere' });
    expect(h.fac.settleCalls).toBe(1);
  });

  it('cancelled → settle_failed{cancelled}', async () => {
    h = await makeHarness();
    const p = await h.pay();
    h.seller.tamper = { before: () => void h.chain.cancelAuthorization(p.accepted.asset, h.buyer, p.nonce) };
    const id = expectPending(await h.call(p));
    await h.gw.reconciler.tick();
    expect(h.row(id)!).toMatchObject({ state: 'settle_failed', reject_reason: 'cancelled' });
  });

  it('never used: expired only at a block with timestamp > validBefore + 5, terminal by validBefore + 60', async () => {
    h = await makeHarness();
    h.fac.settleScript = Array(300).fill({ kind: 'status', status: 500 });
    const p = await h.pay();
    const id = expectPending(await h.call(p));
    h.chain.advance(p.validBefore + 5 - h.clock.t); // head.timestamp == validBefore + 5
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settle_pending');
    h.chain.advance(1);
    await h.gw.reconciler.tick();
    expect(h.row(id)!).toMatchObject({ state: 'settle_failed', reject_reason: 'expired', payment_payload: null });
    expect(h.clock.t).toBeLessThanOrEqual(p.validBefore + 60);
    expect(await usesOf(p)).toBe(0);
  });

  it('lagging RPC head: wall clock past expiry, head not → no expiry verdict yet', async () => {
    h = await makeHarness();
    h.fac.settleScript = Array(300).fill({ kind: 'status', status: 500 });
    const p = await h.pay();
    const id = expectPending(await h.call(p));
    h.clock.t = p.validBefore + 30; // the node hasn't produced those blocks
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settle_pending');
    expect(h.chain.calls.authorizationState).toBe(0);
    h.chain.mine();
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settle_failed');
  });

  it('used but the log query is behind at expiry → stays pending, then settled', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500, broadcast: true }];
    h.chain.logLag = 10_000n;
    const p = await h.pay();
    const id = expectPending(await h.call(p));
    h.chain.advance(p.validBefore + 10 - h.clock.t);
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settle_pending');
    h.chain.logLag = 0n;
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled');
  });

  it('a settling row younger than 20 s is never re-sent; older than 20 s it is', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500 }];
    const p = await h.pay();
    const id = expectPending(await h.call(p));
    h.db.db.prepare(`UPDATE calls SET state = 'settling', updated_at = ? WHERE request_id = ?`).run(h.clock.t, id);
    h.chain.advance(20);
    await h.gw.reconciler.tick();
    expect(h.fac.settleCalls).toBe(1);
    expect(h.row(id)!.state).toBe('settling');
    h.chain.advance(1);
    await h.gw.reconciler.tick();
    expect(h.fac.settleCalls).toBe(2);
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled');
    expect(await usesOf(p)).toBe(1);
  });

  it('a row the handler is sending is skipped even when old', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500 }];
    const id = expectPending(await h.call(await h.pay()));
    h.gw.sending.add(id);
    h.chain.advance(30);
    await h.gw.reconciler.tick();
    expect(h.fac.settleCalls).toBe(1);
  });

  it('crash in executing / payment_verified: startup sweep → exec_failed, 0 settles', async () => {
    h = await makeHarness();
    h.seller.tamper = { error: 'bad_inputs' };
    const a = (await h.call(await h.pay())).headers['x-request-id'] as string;
    const b = (await h.call(await h.pay())).headers['x-request-id'] as string;
    h.db.db.prepare(`UPDATE calls SET state = 'executing', reject_reason = NULL WHERE request_id = ?`).run(a);
    h.db.db.prepare(`UPDATE calls SET state = 'payment_verified', reject_reason = NULL WHERE request_id = ?`).run(b);
    const gw = await h.restart();
    await gw.start();
    expect(h.row(a)!.state).toBe('exec_failed');
    expect(h.row(b)!.state).toBe('exec_failed');
    expect(h.fac.settleCalls).toBe(0);
  });

  it('crash between persist and settle: restart re-sends from the stored payload → settled → /v1/results', async () => {
    let crash = true;
    h = await makeHarness({
      wrapFacilitator: (f) => ({
        verify: (r, t) => f.verify(r, t),
        supported: (t) => f.supported(t),
        settle: (r, t) => {
          if (crash) throw new Error('process killed before the request left');
          return f.settle(r, t);
        },
      }),
    });
    const p = await h.pay();
    const r = await h.call(p);
    const id = r.headers['x-request-id'] as string;
    // What a kill at that instant leaves on disk: the persisted row, still `settling`.
    h.db.db.prepare(`UPDATE calls SET state = 'settling', reject_reason = NULL WHERE request_id = ?`).run(id);
    expect(h.row(id)!.payment_payload).toBe(p.header);
    expect(h.fac.settleCalls).toBe(0);
    crash = false;
    h.chain.advance(21);
    const gw = await h.restart();
    await gw.start(); // startup sweep + one pass: re-send
    expect(h.fac.settleCalls).toBe(1);
    await gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled');
    const res = await h.results(id);
    expect(res.statusCode).toBe(200);
    expect(await usesOf(p)).toBe(1);
  });

  it('settled with no live response for > 30 s → delivery_failed; still served; response NULL after 24 h', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 503, broadcast: true }];
    const id = expectPending(await h.call(await h.pay()));
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled');
    h.clock.t += 30;
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('settled');
    h.clock.t += 1;
    await h.gw.reconciler.tick();
    expect(h.row(id)!.state).toBe('delivery_failed');
    expect((await h.results(id)).statusCode).toBe(200);
    h.clock.t += 24 * 3600;
    await h.gw.reconciler.tick();
    expect(h.row(id)!.response).toBeNull();
    const gone = await h.results(id);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ error: 'result_not_found', message: `No stored result for request ${id}.` });
  });

  it('a retry answer of 401 pauses the gateway and does not terminalize', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500 }, { kind: 'status', status: 401 }];
    const id = expectPending(await h.call(await h.pay()));
    await h.gw.reconciler.tick();
    expect(h.db.isPaused()).toBe(true);
    expect(h.row(id)!.state).toBe('settle_pending');
  });
});

describe('/v1/results (SPEC §6.1)', () => {
  it('needs the payer signature within 300 s; anyone else gets 404', async () => {
    h = await makeHarness();
    const r = await h.call(await h.pay());
    const id = r.headers['x-request-id'] as string;
    expect((await h.results(id)).statusCode).toBe(200);
    const { generatePrivateKey } = await import('viem/accounts');
    expect((await h.results(id, { key: generatePrivateKey() })).statusCode).toBe(404);
    expect((await h.results(id, { at: h.clock.t - 301 })).statusCode).toBe(404);
    expect((await h.results(id, { at: h.clock.t - 300 })).statusCode).toBe(200);
    expect((await h.gw.app.inject({ method: 'GET', url: `/v1/results/${id}` })).statusCode).toBe(404);
    expect((await h.results(`0x${'00'.repeat(32)}`)).statusCode).toBe(404);
  });

  it('rows that never settled are 404 with no body bytes (INV-10)', async () => {
    h = await makeHarness();
    const { generatePrivateKey } = await import('viem/accounts');
    h.seller.tamper = { signWith: generatePrivateKey() };
    const r = await h.call(await h.pay());
    const res = await h.results(r.headers['x-request-id'] as string);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('verdict');
  });
});

