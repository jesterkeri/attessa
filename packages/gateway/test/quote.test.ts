import { afterEach, describe, expect, it } from 'vitest';
import { eip712Domain, livenessDigest, livenessFromJson, recoverDigestSigner } from '@attessa/core';
import { b64json, makeHarness, randRequestId, type Harness } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

describe('402 quote (SPEC §6.2 step 2)', () => {
  it('PAYMENT-REQUIRED is the exact x402 v2 object, one entry per configured asset', async () => {
    h = await makeHarness();
    const r = await h.quote();
    expect(r.statusCode).toBe(402);
    const pr = b64json(r.headers['payment-required']);
    expect(pr).toEqual({
      x402Version: 2,
      error: 'PAYMENT-SIGNATURE header is required',
      resource: {
        url: 'https://risk.example/v1/evaluate',
        description: "Payment check. You are charged only if the response's proof verifies.",
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:11142220',
          amount: '20000',
          asset: '0x01c5c0122039549ad1493b8220cabedd739bc44e',
          payTo: h.cfg.payTo,
          maxTimeoutSeconds: 120,
          extra: {
            name: 'USDC',
            version: '2',
            assetTransferMethod: 'eip3009',
            paymentFlow: 'authorization',
            attestedExec: { v: '1', chainId: '11142220', registry: h.cfg.registry, agentId: '7', liveness: null },
          },
        },
      ],
      extensions: {},
    });
    // Nothing was executed or verified for a quote.
    expect(h.seller.evaluateCalls).toBe(0);
    expect(h.fac.verifyCalls).toBe(0);
    expect(h.rows()).toHaveLength(0);
  });

  it('mainnet offers USDC and USA₮ with their pinned EIP-712 domains', async () => {
    h = await makeHarness({ network: 'celo' });
    const offers = await h.offers();
    expect(offers.map((o) => [o.network, o.asset, o.extra.name, o.extra.version])).toEqual([
      ['eip155:42220', '0xceba9300f2b948710d2653dd7b07f33a8b32118c', 'USDC', '2'],
      ['eip155:42220', '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771', 'Tether America USD', '1'],
    ]);
  });

  it('X-Attest-Challenge puts a liveness object signed by the enclave key in every entry', async () => {
    h = await makeHarness();
    const challenge = randRequestId();
    const r = await h.quote({ 'x-attest-challenge': challenge });
    const entry = b64json(r.headers['payment-required']).accepts[0];
    const live = entry.extra.attestedExec.liveness;
    const l = livenessFromJson(live.liveness);
    expect(l.challenge).toBe(challenge);
    const signer = await recoverDigestSigner(livenessDigest(eip712Domain(11142220n, h.cfg.registry), l), live.signature);
    expect(signer).toBe(h.seller.signer);
  });

  it('echoes X-Request-Id on an unpaid request only when sent', async () => {
    h = await makeHarness();
    expect((await h.quote()).headers['x-request-id']).toBeUndefined();
    const id = randRequestId();
    expect((await h.quote({ 'x-request-id': id })).headers['x-request-id']).toBe(id);
  });

  it('malformed challenge or request id → 400 bad_request, unpaid tail', async () => {
    h = await makeHarness();
    const r = await h.quote({ 'x-attest-challenge': '0xABC' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'bad_request', suggestion: 'fix_request' });
    expect(r.json().message).toMatch(/Nothing was signed\.$/);
    expect((await h.quote({ 'x-request-id': `0x${'A'.repeat(64)}` })).statusCode).toBe(400);
  });
});

describe('body validation before payment (SPEC §6.2 step 1, §4.3)', () => {
  const cases: Array<[string, string]> = [
    ['uppercase hex', JSON.stringify({ chainId: '11142220', payTo: `0x${'AB'.repeat(20)}`, asset: `0x${'ab'.repeat(20)}`, amount: '1' })],
    ['wrong chainId', JSON.stringify({ chainId: '42220', payTo: `0x${'ab'.repeat(20)}`, asset: `0x${'ab'.repeat(20)}`, amount: '1' })],
    ['unknown key', JSON.stringify({ chainId: '11142220', payTo: `0x${'ab'.repeat(20)}`, asset: `0x${'ab'.repeat(20)}`, amount: '1', x: 1 })],
    ['missing key', JSON.stringify({ chainId: '11142220', payTo: `0x${'ab'.repeat(20)}`, amount: '1' })],
    ['leading zero amount', JSON.stringify({ chainId: '11142220', payTo: `0x${'ab'.repeat(20)}`, asset: `0x${'ab'.repeat(20)}`, amount: '01' })],
    ['not json', '{"chainId":'],
    ['array', '[]'],
    ['over 2048 bytes', JSON.stringify({ chainId: '11142220', payTo: `0x${'ab'.repeat(20)}`, asset: `0x${'ab'.repeat(20)}`, amount: '1', pad: 'x'.repeat(2100) })],
  ];
  for (const [name, body] of cases) {
    it(`${name} → 400 before any verify, paid or not`, async () => {
      h = await makeHarness();
      const unpaid = await h.gw.app.inject({ method: 'POST', url: '/v1/evaluate', headers: { 'content-type': 'application/json' }, payload: body });
      expect(unpaid.statusCode).toBe(400);
      expect(unpaid.json().error).toBe('bad_request');
      const p = await h.pay();
      const paid = await h.call(p, { body });
      expect(paid.statusCode).toBe(400);
      expect(paid.json().message).toMatch(/Your payment permission wasn't used\.$/);
      expect(h.fac.verifyCalls).toBe(0);
      expect(h.fac.settleCalls).toBe(0);
      expect(h.rows()).toHaveLength(0);
    });
  }
});

describe('PAYMENT-SIGNATURE decoding and the accepted requirement (SPEC §6.2 step 3)', () => {
  async function expect402(r: Awaited<ReturnType<Harness['call']>>, detail: string) {
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ error: 'payment_invalid', detail });
    expect(h.fac.verifyCalls).toBe(0);
    expect(h.fac.settleCalls).toBe(0);
    expect(h.rows()).toHaveLength(0);
  }

  it('not base64 / not JSON / missing fields → payment_invalid{invalid_payload}', async () => {
    h = await makeHarness();
    await expect402(await h.call('not base64!'), 'invalid_payload');
    await expect402(await h.call(Buffer.from('{"x402Version":2').toString('base64')), 'invalid_payload');
    const p = await h.pay({ payload: (x) => ({ ...x, payload: { signature: x.payload.signature } }) });
    await expect402(await h.call(p), 'invalid_payload');
    const q = await h.pay({ payload: (x) => ({ ...x, payload: { ...x.payload, authorization: { ...x.payload.authorization, value: 20000 } } }) });
    await expect402(await h.call(q), 'invalid_payload');
    const u = await h.pay({ payload: (x) => ({ ...x, extra: 1 }) });
    await expect402(await h.call(u), 'invalid_payload');
  });

  it('x402 v1 payload → requirements_mismatch', async () => {
    h = await makeHarness();
    await expect402(await h.call(await h.pay({ payload: (x) => ({ ...x, x402Version: 1 }) })), 'requirements_mismatch');
  });

  const mismatches: Array<[string, (a: Record<string, any>) => Record<string, any>]> = [
    ['network (legacy v1 name)', (a) => ({ ...a, network: 'celo-sepolia' })],
    ['scheme', (a) => ({ ...a, scheme: 'upto' })],
    ['asset', (a) => ({ ...a, asset: `0x${'11'.repeat(20)}` })],
    ['amount', (a) => ({ ...a, amount: '1' })],
    ['payTo', (a) => ({ ...a, payTo: `0x${'22'.repeat(20)}` })],
    ['assetTransferMethod', (a) => ({ ...a, extra: { ...a.extra, assetTransferMethod: 'permit2' } })],
    ['paymentFlow', (a) => ({ ...a, extra: { ...a.extra, paymentFlow: 'other' } })],
    ['domain name', (a) => ({ ...a, extra: { ...a.extra, name: 'USD Coin' } })],
    ['maxTimeoutSeconds', (a) => ({ ...a, maxTimeoutSeconds: 600 })],
    ['extra field', (a) => ({ ...a, extra: { ...a.extra, more: true } })],
    ['registry in attestedExec', (a) => ({ ...a, extra: { ...a.extra, attestedExec: { ...a.extra.attestedExec, registry: `0x${'33'.repeat(20)}` } } })],
    ['liveness of the wrong type', (a) => ({ ...a, extra: { ...a.extra, attestedExec: { ...a.extra.attestedExec, liveness: 'x' } } })],
  ];
  for (const [name, mut] of mismatches) {
    it(`accepted differs in ${name} → requirements_mismatch`, async () => {
      h = await makeHarness();
      await expect402(await h.call(await h.pay({ accepted: mut })), 'requirements_mismatch');
    });
  }

  it('accepted with the liveness object from a challenged quote still matches', async () => {
    h = await makeHarness();
    const q = await h.quote({ 'x-attest-challenge': randRequestId() });
    const live = b64json(q.headers['payment-required']).accepts[0].extra.attestedExec.liveness;
    const p = await h.pay({ accepted: (a) => ({ ...a, extra: { ...a.extra, attestedExec: { ...a.extra.attestedExec, liveness: live } } }) });
    expect((await h.call(p)).statusCode).toBe(200);
  });

  it('authorization.to ≠ payTo or value ≠ amount → requirements_mismatch', async () => {
    h = await makeHarness();
    await expect402(await h.call(await h.pay({ to: `0x${'44'.repeat(20)}` })), 'requirements_mismatch');
    await expect402(await h.call(await h.pay({ value: '19999' })), 'requirements_mismatch');
  });

  it('validBefore − now < 40 s → authorization_window_too_short; 40 s passes', async () => {
    h = await makeHarness();
    const r = await h.call(await h.pay({ validBefore: h.clock.t + 39 }));
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toBe('authorization_window_too_short');
    expect(h.fac.verifyCalls).toBe(0);
    expect((await h.call(await h.pay({ validBefore: h.clock.t + 40 }))).statusCode).toBe(200);
  });

  it('USA₮ v2 accepted requirement is matched, verified and settled on the USA₮ asset', async () => {
    h = await makeHarness({ network: 'celo' });
    const p = await h.pay({ offer: 1 });
    expect(p.accepted.asset).toBe('0xd2ab3c9a02dbbab236bfec45d1d755df4267f771');
    const r = await h.call(p);
    expect(r.statusCode).toBe(200);
    const row = h.row(r.headers['x-request-id'] as string)!;
    expect(row.asset).toBe('0xd2ab3c9a02dbbab236bfec45d1d755df4267f771');
    expect(row.state).toBe('delivered');
    expect(h.chain.isUsed('0xd2ab3c9a02dbbab236bfec45d1d755df4267f771', h.buyer, p.nonce)).toBe(true);
    expect(h.fac.settleCalls).toBe(1);
  });

  it('a USDC-signed authorization presented as the USA₮ entry fails verify (the domain differs), no row', async () => {
    h = await makeHarness({ network: 'celo' });
    const usdc = await h.pay({ offer: 0 });
    const offers = await h.offers();
    const forged = JSON.parse(Buffer.from(usdc.header, 'base64').toString('utf8'));
    forged.accepted = offers[1];
    const r = await h.call(Buffer.from(JSON.stringify(forged)).toString('base64'));
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ error: 'payment_invalid', detail: 'invalid_exact_evm_payload_signature' });
    expect(h.rows()).toHaveLength(0);
  });
});

