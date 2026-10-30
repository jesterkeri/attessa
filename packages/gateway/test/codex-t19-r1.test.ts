import { getAddress } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import type { Facilitator } from '../src/facilitator.ts';
import { makeHarness, type Harness } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

/** A facilitator whose 2xx `/verify` answers `isValid: true` with the given `payer` field (absent when undefined). */
const verifyAnswers =
  (payer: () => unknown) =>
  (f: Facilitator): Facilitator => ({
    verify: async (r, t) => {
      const v = await f.verify(r, t);
      const p = payer();
      return { ...v, body: p === undefined ? { isValid: true } : { isValid: true, payer: p } };
    },
    supported: (t) => f.supported(t),
    settle: (r, t) => f.settle(r, t),
  });

describe('Codex T19 r1: proof lifetime (SPEC §2.3, §6.2 step 9, INV-9)', () => {
  it('a validly signed proof with expiresAt = issuedAt + 601 → proof_rejected{proof_expired}, no settle', async () => {
    h = await makeHarness();
    h.seller.tamper = { proof: (p) => ({ ...p, expiresAt: p.issuedAt + 601n }) };
    const r = await h.call(await h.pay());
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: 'proof_rejected', detail: 'proof_expired', suggestion: 'wait_or_cancel' });
    expect(r.headers['x-attested-proof']).toBeUndefined();
    expect(h.row(r.headers['x-request-id'] as string)!.state).toBe('proof_rejected');
    expect(h.fac.settleCalls).toBe(0);
  });

  it('expiresAt = issuedAt + 599 → proof_rejected{proof_expired}, no settle', async () => {
    h = await makeHarness();
    h.seller.tamper = { proof: (p) => ({ ...p, expiresAt: p.issuedAt + 599n }) };
    const r = await h.call(await h.pay());
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: 'proof_rejected', detail: 'proof_expired' });
    expect(h.fac.settleCalls).toBe(0);
  });
});

describe('Codex T19 r1: payer from /verify (SPEC §6.2 steps 5-6)', () => {
  for (const [name, payer] of [
    ['no payer', undefined],
    ['an empty payer', ''],
    ['a non-address payer', 'buyer'],
    ['a non-string payer', 42],
  ] as const) {
    it(`2xx isValid:true with ${name} → payment_invalid{unexpected_verify_error}, no row, nothing executed`, async () => {
      h = await makeHarness({ wrapFacilitator: verifyAnswers(() => payer) });
      const r = await h.call(await h.pay());
      expect(r.statusCode).toBe(402);
      expect(r.json()).toMatchObject({ error: 'payment_invalid', detail: 'unexpected_verify_error' });
      expect(h.rows()).toHaveLength(0);
      expect(h.seller.evaluateCalls).toBe(0);
      expect(h.fac.settleCalls).toBe(0);
    });
  }

  it('a /verify payer other than authorization.from → payment_invalid{payer_mismatch}, no row', async () => {
    h = await makeHarness({ wrapFacilitator: verifyAnswers(() => '0x000000000000000000000000000000000000dead') });
    const r = await h.call(await h.pay());
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ error: 'payment_invalid', detail: 'payer_mismatch' });
    expect(h.rows()).toHaveLength(0);
    expect(h.seller.evaluateCalls).toBe(0);
  });

  it('a checksummed /verify payer equal to authorization.from is accepted and stored lowercase', async () => {
    h = await makeHarness({ wrapFacilitator: verifyAnswers(() => getAddress(h.buyer)) });
    const r = await h.call(await h.pay());
    expect(r.statusCode).toBe(200);
    expect(h.row(r.headers['x-request-id'] as string)!.payer).toBe(h.buyer);
  });
});
