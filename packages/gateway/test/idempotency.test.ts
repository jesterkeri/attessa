import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, randRequestId, type Harness, type Payment } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

type Res = Awaited<ReturnType<Harness['call']>>;

function setState(id: string, state: string): void {
  h.db.db.prepare('UPDATE calls SET state = ? WHERE request_id = ?').run(state, id);
}

async function first(): Promise<{ p: Payment; r: Res; id: string }> {
  const p = await h.pay();
  const r = await h.call(p);
  return { p, r, id: r.headers['x-request-id'] as string };
}

/** Counters that must not move on an idempotent repeat. */
function snapshot() {
  return { verify: h.fac.verifyCalls, settle: h.fac.settleCalls, evaluate: h.seller.evaluateCalls };
}

describe('duplicate PAYMENT-SIGNATURE in each existing state (SPEC §6.2 step 4)', () => {
  for (const state of ['delivered', 'settled', 'delivery_failed'] as const) {
    it(`${state}: same request + same payment → 200 with the stored bytes; nothing re-run or re-settled`, async () => {
      h = await makeHarness();
      const { p, r, id } = await first();
      expect(r.statusCode).toBe(200);
      setState(id, state);
      const before = snapshot();
      const again = await h.call(p);
      expect(again.statusCode).toBe(200);
      expect(again.rawPayload.equals(r.rawPayload)).toBe(true);
      expect(again.headers['x-attested-proof']).toBe(r.headers['x-attested-proof']);
      expect(again.headers['payment-response']).toBe(r.headers['payment-response']);
      expect(snapshot()).toEqual(before);
      // `settled` becomes `delivered` once the bytes are written; terminal states stay.
      expect(h.row(id)!.state).toBe(state === 'settled' ? 'delivered' : state);
    });
  }

  it('stored result is repeated even when the authorization now has under 40 s left', async () => {
    h = await makeHarness();
    const { p, r } = await first();
    h.chain.advance(100);
    const again = await h.call(p);
    expect(again.statusCode).toBe(200);
    expect(again.rawPayload.equals(r.rawPayload)).toBe(true);
    expect(h.fac.settleCalls).toBe(1);
  });

  it('stored result: a different X-Request-Id with the same payment → 409 payment_reused, no bytes', async () => {
    h = await makeHarness();
    const { p } = await first();
    const r = await h.call(p, { requestId: randRequestId() });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('payment_reused');
    expect(r.body).not.toContain('verdict');
    expect(h.fac.settleCalls).toBe(1);
  });

  it('stored result: the same X-Request-Id with another payment → 409 request_id_conflict', async () => {
    h = await makeHarness();
    const id = randRequestId();
    expect((await h.call(await h.pay(), { requestId: id })).statusCode).toBe(200);
    const r = await h.call(await h.pay(), { requestId: id });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('request_id_conflict');
    expect(r.json().message).toBe(
      "This request id or payment permission was already used for a different call. Your payment permission wasn't used.",
    );
    expect(h.fac.verifyCalls).toBe(1);
    expect(h.fac.settleCalls).toBe(1);
  });

  it('stored result: same payment with another body → 409 payment_reused', async () => {
    h = await makeHarness();
    const { p } = await first();
    const other = JSON.parse(h.body);
    other.amount = '1';
    const r = await h.call(p, { body: JSON.stringify(other) });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('payment_reused');
  });

  it('stored result: someone replaying the authorization fields with another key’s signature gets 409, not the bytes', async () => {
    h = await makeHarness();
    const { p } = await first();
    const payload = JSON.parse(Buffer.from(p.header, 'base64').toString('utf8'));
    const thief = privateKeyToAccount(generatePrivateKey());
    payload.payload.signature = await thief.signMessage({ message: 'x' });
    const r = await h.call(Buffer.from(JSON.stringify(payload)).toString('base64'));
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('payment_reused');
    expect(r.body).not.toContain('verdict');
  });

  for (const state of ['settling', 'settle_pending'] as const) {
    it(`${state}: same pairing → 202 settle_pending (+ PAYMENT-RESPONSE when a tx is known); other pairing → 409`, async () => {
      h = await makeHarness();
      h.fac.settleScript = [{ kind: 'status', status: 500 }];
      const { p, r, id } = await first();
      expect(r.statusCode).toBe(202);
      setState(id, state);
      const before = snapshot();
      const again = await h.call(p);
      expect(again.statusCode).toBe(202);
      expect(again.json()).toMatchObject({ error: 'settle_pending', suggestion: 'poll_results', requestId: id });
      expect(again.headers['retry-after']).toBe('3');
      expect(again.headers['payment-response']).toBeUndefined();
      expect(again.body).not.toContain('verdict');
      h.db.db.prepare('UPDATE calls SET settle_tx = ? WHERE request_id = ?').run(`0x${'ab'.repeat(32)}`, id);
      const withTx = await h.call(p);
      expect(withTx.headers['payment-response']).toBeDefined();
      expect(snapshot()).toEqual(before);
      const conflict = await h.call(p, { requestId: randRequestId() });
      expect(conflict.statusCode).toBe(409);
    });
  }

  for (const state of ['payment_verified', 'executing'] as const) {
    it(`${state}: same pairing → 409 in_progress with Retry-After 2; other pairing → 409`, async () => {
      h = await makeHarness();
      const { p, id } = await first();
      setState(id, state);
      const before = snapshot();
      const again = await h.call(p);
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe('in_progress');
      expect(again.headers['retry-after']).toBe('2');
      expect(snapshot()).toEqual(before);
      expect((await h.call(p, { requestId: randRequestId() })).json().error).toBe('payment_reused');
    });
  }

  it('exec_failed: repeats the same error; other pairing → 409', async () => {
    h = await makeHarness();
    h.seller.tamper = { delayMs: 10_000 };
    const { p, r } = await first();
    expect(r.statusCode).toBe(504);
    h.seller.tamper = {};
    const before = snapshot();
    const again = await h.call(p);
    expect(again.statusCode).toBe(504);
    expect(again.json()).toMatchObject({ error: 'execution_timeout', detail: null });
    expect(snapshot()).toEqual(before);
    expect((await h.call(p, { requestId: randRequestId() })).statusCode).toBe(409);
  });

  it('proof_rejected: repeats the same error, with the same check', async () => {
    h = await makeHarness();
    h.seller.tamper = { signWith: generatePrivateKey() };
    const { p, r } = await first();
    expect(r.json().detail).toBe('bad_signature');
    h.seller.tamper = {};
    const before = snapshot();
    const again = await h.call(p);
    expect(again.statusCode).toBe(502);
    expect(again.json()).toMatchObject({ error: 'proof_rejected', detail: 'bad_signature' });
    expect(snapshot()).toEqual(before);
  });

  it('too_late: repeats 502 authorization_expiring', async () => {
    h = await makeHarness();
    const p = await h.pay({ validBefore: h.clock.t + 45 });
    h.seller.tamper = { before: () => h.chain.advance(36) };
    expect((await h.call(p)).json().error).toBe('authorization_expiring');
    h.seller.tamper = {};
    const before = snapshot();
    const again = await h.call(p);
    expect(again.statusCode).toBe(502);
    expect(again.json().error).toBe('authorization_expiring');
    expect(snapshot()).toEqual(before);
  });

  it('settle_failed: repeats 502 settle_failed{reason}', async () => {
    h = await makeHarness();
    const p = await h.pay();
    h.seller.tamper = { before: () => void h.chain.cancelAuthorization(p.accepted.asset, h.buyer, p.nonce) };
    const r = await h.call(p);
    expect(r.statusCode).toBe(202);
    await h.gw.reconciler.tick();
    const id = r.headers['x-request-id'] as string;
    expect(h.row(id)!.state).toBe('settle_failed');
    const before = snapshot();
    const again = await h.call(p);
    expect(again.statusCode).toBe(502);
    expect(again.json()).toMatchObject({ error: 'settle_failed', detail: 'cancelled', suggestion: 'retry_new_request' });
    expect(again.json().message).toBe(
      "Payment didn't go through: the payment permission was cancelled. The result was withheld. Your payment permission wasn't used.",
    );
    expect(again.body).not.toContain('verdict');
    expect(snapshot()).toEqual(before);
  });

  it('two concurrent identical PAYMENT-SIGNATUREs: one runs, the other gets 409 in_progress; one settle', async () => {
    h = await makeHarness();
    h.seller.tamper = { delayMs: 150 };
    const p = await h.pay();
    const [a, b] = await Promise.all([h.call(p), h.call(p)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect([a, b].find((r) => r.statusCode === 409)!.json().error).toBe('in_progress');
    expect(h.fac.verifyCalls).toBe(1);
    expect(h.fac.settleCalls).toBe(1);
    expect(h.rows()).toHaveLength(1);
  });
});
