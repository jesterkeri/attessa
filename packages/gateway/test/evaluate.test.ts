import { derivedRequestId } from '@attessa/core';
import { generatePrivateKey } from 'viem/accounts';
import { hexToBigInt, numberToHex, slice, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, randNonce, randRequestId, type Harness } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

type Res = Awaited<ReturnType<Harness['call']>>;

/** INV-10: a non-200 never carries enclave body bytes or a proof. */
function noResult(r: Res): void {
  expect(r.statusCode).not.toBe(200);
  expect(r.headers['x-attested-proof']).toBeUndefined();
  expect(r.body).not.toContain('verdict');
  expect(r.body).not.toContain('rulesVersion');
  const b = r.json();
  expect(Object.keys(b).sort()).toEqual(['correlationId', 'detail', 'error', 'message', 'requestId', 'suggestion']);
}

async function rejected(r: Res, check: string): Promise<void> {
  noResult(r);
  expect(r.statusCode).toBe(502);
  expect(r.json()).toMatchObject({ error: 'proof_rejected', detail: check, suggestion: 'wait_or_cancel' });
  expect(r.json().message).toMatch(/Your payment permission wasn't used\.$/);
  const row = h.row(r.headers['x-request-id'] as string)!;
  expect(row.state).toBe('proof_rejected');
  expect(row.reject_reason).toBe(check);
  expect(h.fac.settleCalls).toBe(0);
}

describe('happy path (SPEC §6.2 steps 5–12)', () => {
  it('verify → execute → proof → persist → settle → 200 with exact bytes, proof, PAYMENT-RESPONSE, X-Request-Id → delivered', async () => {
    h = await makeHarness();
    const p = await h.pay();
    const r = await h.call(p);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-encoding']).toBe('identity');
    const id = r.headers['x-request-id'] as string;
    // No X-Request-Id from the buyer: the gateway derived keccak256(asset ‖ payer ‖ nonce).
    expect(id).toBe(derivedRequestId(h.cfg.assets[0]!.pin.address, h.buyer, p.nonce));
    const row = h.row(id)!;
    expect(row.state).toBe('delivered');
    expect(Buffer.from(row.response!).equals(r.rawPayload)).toBe(true);
    expect(row.proof_header).toBe(r.headers['x-attested-proof']);
    expect(row.payment_payload).toBeNull();
    expect(row.settle_tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.fac.verifyCalls).toBe(1);
    expect(h.fac.settleCalls).toBe(1);
    expect(h.seller.lastRequest).toMatchObject({ requestId: id, method: 'POST', path: '/v1/evaluate', paymentId: p.nonce });
  });

  it('a buyer X-Request-Id is used and echoed', async () => {
    h = await makeHarness();
    const id = randRequestId();
    const r = await h.call(await h.pay(), { requestId: id });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-request-id']).toBe(id);
    expect(h.row(id)!.state).toBe('delivered');
  });

  it('requestHash covers the path and query as sent', async () => {
    h = await makeHarness();
    const r = await h.call(await h.pay(), { url: '/v1/evaluate?x=1' });
    expect(r.statusCode).toBe(200);
    expect(h.seller.lastRequest!.path).toBe('/v1/evaluate?x=1');
  });
});

describe('paused (step 0)', () => {
  it('503 gateway_paused for unpaid and paid, no verify, no execution', async () => {
    h = await makeHarness();
    const pay = await h.pay();
    h.db.setPaused(true);
    const u = await h.quote();
    expect(u.statusCode).toBe(503);
    expect(u.json()).toMatchObject({ error: 'gateway_paused', suggestion: 'retry_later' });
    expect(u.json().message).toBe("The service can't take payments right now. Nothing was signed.");
    const p = await h.call(pay);
    expect(p.statusCode).toBe(503);
    expect(p.json().message).toBe("The service can't take payments right now. Your payment permission wasn't used.");
    expect(h.fac.verifyCalls).toBe(0);
    expect(h.seller.evaluateCalls).toBe(0);
    expect(h.rows()).toHaveLength(0);
  });
});

describe('verify (step 5, INV-21)', () => {
  it('isValid=false → 402 payment_invalid{reason}, no row, nothing executed', async () => {
    h = await makeHarness();
    const poor = generatePrivateKey();
    const r = await h.call(await h.pay({ key: poor }));
    noResult(r);
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ error: 'payment_invalid', detail: 'insufficient_funds' });
    expect(h.fac.verifyCalls).toBe(1);
    expect(h.rows()).toHaveLength(0);
    expect(h.seller.evaluateCalls).toBe(0);
  });

  it('facilitator /verify error → payment_invalid{unexpected_verify_error}, no row', async () => {
    h = await makeHarness();
    h.fac.verifyStatus = 500;
    const r = await h.call(await h.pay());
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ error: 'payment_invalid', detail: 'unexpected_verify_error', suggestion: 'retry_later' });
    expect(h.rows()).toHaveLength(0);
  });

  it('a used nonce fails verify → no row, no settle', async () => {
    h = await makeHarness();
    const p = await h.pay();
    h.chain.transferWithAuthorization(p.accepted.asset, h.buyer, h.buyer, 0n, p.nonce);
    const r = await h.call(p);
    expect(r.statusCode).toBe(402);
    expect(h.rows()).toHaveLength(0);
    expect(h.fac.settleCalls).toBe(0);
  });
});

describe('per-payer unsettled limit (SPEC §6.1, step 5)', () => {
  it('6th unsettled paid call in an hour from one payer → 429 before execution, no row', async () => {
    h = await makeHarness();
    h.seller.tamper = { error: 'bad_inputs' };
    for (let i = 0; i < 5; i++) {
      const r = await h.call(await h.pay());
      expect(r.statusCode).toBe(503);
    }
    expect(h.seller.evaluateCalls).toBe(5);
    h.seller.tamper = {};
    const r = await h.call(await h.pay());
    noResult(r);
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('rate_limited');
    expect(r.headers['retry-after']).toMatch(/^\d+$/);
    expect(h.seller.evaluateCalls).toBe(5);
    expect(h.rows()).toHaveLength(5);
    expect(h.fac.settleCalls).toBe(0);
    // Another payer is unaffected.
    const other = generatePrivateKey();
    const { privateKeyToAccount } = await import('viem/accounts');
    h.chain.fund(h.cfg.assets[0]!.pin.address, privateKeyToAccount(other).address, 10n ** 6n);
    expect((await h.call(await h.pay({ key: other }))).statusCode).toBe(200);
    // An hour later the payer may call again.
    h.chain.advance(3601);
    expect((await h.call(await h.pay())).statusCode).toBe(200);
  });
});

describe('signer pre-check and execution (steps 7–8)', () => {
  it('revoked signer → exec_failed, 503 enclave_unavailable, never executed or settled', async () => {
    h = await makeHarness();
    h.chain.signers.set(h.seller.signer, { code: 'SIGNER_REVOKED', agentId: 7n, releaseId: h.seller.releaseId });
    const r = await h.call(await h.pay());
    noResult(r);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: 'enclave_unavailable' });
    expect(r.json().message).toBe("The service is offline. Your payment permission wasn't used.");
    expect(h.row(r.headers['x-request-id'] as string)!.state).toBe('exec_failed');
    expect(h.seller.evaluateCalls).toBe(0);
    expect(h.fac.settleCalls).toBe(0);
  });

  it('signer revoked between pre-check and proof check → proof_rejected{signer_not_active}', async () => {
    h = await makeHarness();
    h.seller.tamper = {
      before: () => void h.chain.signers.set(h.seller.signer, { code: 'SIGNER_REVOKED', agentId: 7n, releaseId: h.seller.releaseId }),
    };
    await rejected(await h.call(await h.pay()), 'signer_not_active');
  });

  it('timeout → exec_failed, 504 execution_timeout', async () => {
    h = await makeHarness();
    h.seller.tamper = { delayMs: 10_000 };
    const r = await h.call(await h.pay());
    noResult(r);
    expect(r.statusCode).toBe(504);
    expect(r.json().error).toBe('execution_timeout');
    expect(h.row(r.headers['x-request-id'] as string)!).toMatchObject({ state: 'exec_failed', reject_reason: 'execution_timeout' });
    expect(h.fac.settleCalls).toBe(0);
  });

  for (const [err, status, code] of [
    ['bad_request', 400, 'bad_request'],
    ['bad_inputs', 503, 'enclave_unavailable'],
    ['inputs_unavailable', 503, 'enclave_unavailable'],
  ] as const) {
    it(`seller-host ${err} → exec_failed, ${status} ${code}`, async () => {
      h = await makeHarness();
      h.seller.tamper = { error: err };
      const r = await h.call(await h.pay());
      noResult(r);
      expect(r.statusCode).toBe(status);
      expect(r.json().error).toBe(code);
      expect(h.row(r.headers['x-request-id'] as string)!.state).toBe('exec_failed');
      expect(h.fac.settleCalls).toBe(0);
    });
  }

  it('seller-host unreachable → 503 enclave_unavailable', async () => {
    h = await makeHarness();
    h.seller.tamper = { unreachable: true };
    const r = await h.call(await h.pay());
    expect(r.statusCode).toBe(503);
    expect(h.row(r.headers['x-request-id'] as string)!.state).toBe('exec_failed');
    expect(h.fac.settleCalls).toBe(0);
  });
});

describe('proof check (step 9, INV-9): every failure is proof_rejected and never settles', () => {
  it('forged proof: valid low-s signature by another key, the real signer in the header → bad_signature', async () => {
    h = await makeHarness();
    h.seller.tamper = { signWith: generatePrivateKey() };
    await rejected(await h.call(await h.pay()), 'bad_signature');
  });

  it('high-s twin of a valid signature → bad_signature', async () => {
    h = await makeHarness();
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    h.seller.tamper = {
      signature: (sig: Hex) => {
        const s = hexToBigInt(slice(sig, 32, 64));
        const v = hexToBigInt(slice(sig, 64, 65));
        return `${slice(sig, 0, 32)}${numberToHex(N - s, { size: 32 }).slice(2)}${v === 27n ? '1c' : '1b'}` as Hex;
      },
    };
    await rejected(await h.call(await h.pay()), 'bad_signature');
  });

  it('v outside {27, 28} → bad_signature', async () => {
    h = await makeHarness();
    h.seller.tamper = { signature: (sig: Hex) => `${slice(sig, 0, 64)}${hexToBigInt(slice(sig, 64, 65)) === 27n ? '00' : '01'}` as Hex };
    await rejected(await h.call(await h.pay()), 'bad_signature');
  });

  it('wrong requestId → request_mismatch', async () => {
    h = await makeHarness();
    h.seller.tamper = { proof: (p) => ({ ...p, requestId: randRequestId() }) };
    await rejected(await h.call(await h.pay()), 'request_mismatch');
  });

  it('wrong requestHash → request_mismatch', async () => {
    h = await makeHarness();
    h.seller.tamper = { proof: (p) => ({ ...p, requestHash: randRequestId() }) };
    await rejected(await h.call(await h.pay()), 'request_mismatch');
  });

  it('wrong paymentId → payment_mismatch', async () => {
    h = await makeHarness();
    h.seller.tamper = { proof: (p) => ({ ...p, paymentId: randNonce() }) };
    await rejected(await h.call(await h.pay()), 'payment_mismatch');
  });

  it('response bytes changed after signing → response_hash_mismatch', async () => {
    h = await makeHarness();
    h.seller.tamper = { response: (b) => Buffer.from(b.toString('utf8').replace('"rulesVersion":"1"', '"rulesVersion":"2"')) };
    await rejected(await h.call(await h.pay()), 'response_hash_mismatch');
  });

  it('inputsHash not over the response inputs → inputs_hash_mismatch', async () => {
    h = await makeHarness();
    h.seller.tamper = { proof: (p) => ({ ...p, inputsHash: randRequestId() }) };
    await rejected(await h.call(await h.pay()), 'inputs_hash_mismatch');
  });

  it('agentId or releaseId other than the signer’s → agent_mismatch / release_not_approved', async () => {
    h = await makeHarness();
    h.seller.tamper = { proof: (p) => ({ ...p, agentId: 8n }) };
    await rejected(await h.call(await h.pay()), 'agent_mismatch');
    await h.close();
    h = await makeHarness();
    h.seller.tamper = { proof: (p) => ({ ...p, releaseId: randRequestId() }) };
    await rejected(await h.call(await h.pay()), 'release_not_approved');
  });

  it('issuedAt 121 s off → clock_skew; 120 s passes', async () => {
    h = await makeHarness();
    h.seller.tamper = { proof: (p) => ({ ...p, issuedAt: p.issuedAt - 121n }) };
    await rejected(await h.call(await h.pay()), 'clock_skew');
    h.seller.tamper = { proof: (p) => ({ ...p, issuedAt: p.issuedAt + 120n, expiresAt: p.issuedAt + 720n }) };
    expect((await h.call(await h.pay())).statusCode).toBe(200);
  });

  it('expiresAt ≤ now → proof_expired', async () => {
    h = await makeHarness();
    h.seller.tamper = { proof: (p) => ({ ...p, expiresAt: p.issuedAt }) };
    await rejected(await h.call(await h.pay()), 'proof_expired');
  });

  it('stale inputs block (301 s old) → stale_inputs; 299 s passes', async () => {
    h = await makeHarness();
    h.chain.advance(400);
    h.seller.tamper = { blocksBack: 301 };
    await rejected(await h.call(await h.pay()), 'stale_inputs');
    h.seller.tamper = { blocksBack: 299 };
    expect((await h.call(await h.pay())).statusCode).toBe(200);
  });

  it('inputs block unknown, or its hash / timestamp fabricated → stale_inputs', async () => {
    h = await makeHarness();
    h.seller.tamper = { inputs: (i) => ({ ...i, block: { ...i.block, number: '100000' } }) };
    await rejected(await h.call(await h.pay()), 'stale_inputs');
    h.seller.tamper = { inputs: (i) => ({ ...i, block: { ...i.block, hash: randRequestId() } }) };
    const r2 = await h.call(await h.pay());
    expect(r2.json().detail).toBe('stale_inputs');
    h.seller.tamper = { inputs: (i) => ({ ...i, block: { ...i.block, timestamp: String(BigInt(i.block.timestamp) + 1n) } }) };
    const r3 = await h.call(await h.pay());
    expect(r3.json().detail).toBe('stale_inputs');
    expect(h.fac.settleCalls).toBe(0);
  });

  for (const [field, value] of [
    ['code', '0x6080604052'],
    ['nonce', '4'],
    ['balanceWei', '1'],
  ] as const) {
    it(`fabricated inputs.payTo.${field} on a real block → inputs_mismatch, no settle`, async () => {
      h = await makeHarness();
      h.seller.tamper = { inputs: (i) => ({ ...i, payTo: { ...i.payTo, [field]: value } }) };
      await rejected(await h.call(await h.pay()), 'inputs_mismatch');
      expect(h.chain.calls.accountAt).toBeGreaterThan(0);
    });
  }

  it('RPC down during the inputs checks → rejected, never settled', async () => {
    h = await makeHarness();
    const p = await h.pay();
    const orig = h.chain.blockByNumber.bind(h.chain);
    h.chain.blockByNumber = async () => {
      throw new Error('rpc down');
    };
    await rejected(await h.call(p), 'stale_inputs');
    h.chain.blockByNumber = orig;
  });
});

describe('too late (step 10)', () => {
  it('validBefore − now < 10 after the proof check → too_late, 502 authorization_expiring, no settle', async () => {
    h = await makeHarness();
    const p = await h.pay({ validBefore: h.clock.t + 45 });
    h.seller.tamper = { before: () => h.chain.advance(36) };
    const r = await h.call(p);
    noResult(r);
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe('authorization_expiring');
    expect(h.row(r.headers['x-request-id'] as string)!.state).toBe('too_late');
    expect(h.fac.settleCalls).toBe(0);
  });
});

describe('rate limits and in-flight cap (SPEC §6.1)', () => {
  it('121st unpaid evaluate in a minute from one IP → 429 rate_limited', async () => {
    h = await makeHarness();
    for (let i = 0; i < 120; i++) expect((await h.quote()).statusCode).toBe(402);
    const r = await h.quote();
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('rate_limited');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    h.clock.t += 60;
    expect((await h.quote()).statusCode).toBe(402);
  });

  it('31st liveness in a minute → 429', async () => {
    h = await makeHarness();
    const req = () => h.gw.app.inject({ method: 'POST', url: '/v1/liveness', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ challenge: randRequestId() }) });
    for (let i = 0; i < 30; i++) expect((await req()).statusCode).toBe(200);
    expect((await req()).statusCode).toBe(429);
  });

  it('17th concurrent evaluate → 503 gateway_busy', async () => {
    h = await makeHarness();
    h.seller.tamper = { delayMs: 250 };
    const pays = [];
    for (let i = 0; i < 17; i++) pays.push(await h.pay());
    const rs = await Promise.all(pays.map((p) => h.call(p)));
    const codes = rs.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(16);
    expect(codes.filter((c) => c === 503)).toHaveLength(1);
    expect(rs.find((r) => r.statusCode === 503)!.json().error).toBe('gateway_busy');
    expect(h.fac.settleCalls).toBe(16);
  });
});

describe('static routes (SPEC §6.1)', () => {
  it('well-known, healthz, liveness passthrough', async () => {
    h = await makeHarness();
    const wk = await h.gw.app.inject({ method: 'GET', url: '/.well-known/attested-exec.json' });
    expect(wk.json()).toEqual({
      v: '1',
      chainId: '11142220',
      registry: h.cfg.registry,
      agentId: '7',
      origin: 'https://risk.example',
      resources: [{ path: '/v1/evaluate', method: 'POST' }],
    });
    expect((await h.gw.app.inject({ method: 'GET', url: '/healthz' })).body).toBe('{"ok":true}');
    const ch = randRequestId();
    const l = await h.gw.app.inject({ method: 'POST', url: '/v1/liveness', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ challenge: ch }) });
    expect(l.json().liveness.challenge).toBe(ch);
    const bad = await h.gw.app.inject({ method: 'POST', url: '/v1/liveness', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(bad.statusCode).toBe(400);
    expect((await h.gw.app.inject({ method: 'GET', url: '/privacy' })).statusCode).toBe(404);
  });
});
