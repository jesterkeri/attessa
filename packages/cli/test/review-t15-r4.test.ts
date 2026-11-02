import { originHash, signerFromPublicKey } from '@attessa/core';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { revertToError } from '../src/reverts.ts';
import { AGENT, ORIGIN, attestation, onboarded, world, type World } from './harness.ts';

/**
 * Fix for adversary T15 r4: every revert `signer renew` can meet reads "Not renewed" (FLOWS §8 R: renew refused)
 * with advice that works for a running key, no revert quotes an age measured blocks earlier, and
 * AttestationFromFuture has its own line on both paths.
 */

let w: World;
beforeEach(() => {
  w = world();
  onboarded(w);
  w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
});

function activeSigner(signer: Address): void {
  w.chain.signers.set(signer, {
    agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator,
    registeredAt: w.chain.timestamp - 518_400n, expiresAt: w.chain.timestamp + 86_400n, status: 1, attestationHash: `0x${'00'.repeat(32)}`,
  });
}

describe('seller: a report that goes stale while certificates are cached', () => {
  it('renew: the late AttestationStale revert says "Not renewed", quotes no age, and points at a fresh renew', async () => {
    const { doc, publicKey } = attestation(w, { ageSec: 1797 });
    activeSigner(signerFromPublicKey(publicKey));
    w.files.set('att.bin', doc);
    expect(await w.cli('signer', 'renew', '--attestation', 'att.bin', '--yes')).toBe(1);
    expect(w.chain.sent.length).toBeGreaterThan(0);
    expect(w.err).toEqual(["Not renewed: the machine's report is more than 30 minutes old, the most Celo accepts.", 'Run `attessa signer renew` on the machine that holds this key.']);
  });

  it('register: the late AttestationStale revert never claims the report is within 30 minutes', async () => {
    const { doc } = attestation(w, { ageSec: 1797 });
    w.files.set('att.bin', doc);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--yes')).toBe(1);
    expect(w.chain.sent.length).toBeGreaterThan(0);
    expect(w.err[0]).toBe(
      "Not registered: the machine's report is 31 minutes old and Celo accepts 30. Run `attessa signer register --fresh` to get a new report from the same machine (no restart).",
    );
  });
});

describe('seller: revert mapping (FLOWS §8)', () => {
  const ctx = { agent: '412', from: '0x00000000000000000000000000000000000000f1', origin: ORIGIN, releaseId: `0x${'ab'.repeat(32)}`, ageMinutes: 12 };
  const revert = (name: string, args: unknown[] = []) => ({ name, args });

  it('AttestationFromFuture has its own line on register and on renew', () => {
    const reg = revertToError(revert('AttestationFromFuture'), 'x', ctx);
    expect([reg.code, reg.message, reg.next]).toEqual([
      'attestation_from_future',
      "Not registered: the machine's report is dated ahead of Celo's clock.",
      'Check the host clock, then run `attessa signer register --fresh`.',
    ]);
    const ren = revertToError(revert('AttestationFromFuture'), 'x', { ...ctx, renewing: true });
    expect([ren.code, ren.message]).toEqual(['attestation_from_future', "Not renewed: the machine's report is dated ahead of Celo's clock."]);
  });

  it('every revert renewSigner or a certificate step can raise reads "Not renewed" and never suggests a fresh registration', () => {
    const names: Array<[string, unknown[]]> = [
      ['EndpointInactive', []], ['EndpointMismatch', []], ['NotOperator', []], ['AttestationFromFuture', []], ['AttestationStale', []],
      ['DebugPcrs', []], ['ReleaseNotApproved', []], ['BindingMismatch', [4]], ['SignerNotActive', []], ['SignerMismatch', []],
      ['ReleaseMismatch', []], ['Error', ['cert expired']],
    ];
    for (const [name, args] of names) {
      const e = revertToError(revert(name, args), 'x', { ...ctx, renewing: true, bindingWords: () => 'agent 7' });
      expect(e.message, name).toMatch(/^Not renewed: /);
      expect(`${e.message} ${e.next}`, name).not.toMatch(/--fresh|is \d+ minutes old/);
    }
  });
});
