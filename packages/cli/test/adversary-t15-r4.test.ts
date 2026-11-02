import { originHash, signerFromPublicKey } from '@attessa/core';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, ORIGIN, attestation, onboarded, world, type World } from './harness.ts';

/**
 * Adversary T15 round 4. FLOWS §8 "R: renew refused": every `signer renew` refusal reads "Not renewed: {reason}.".
 * The off-chain stale check says so, but when the report goes stale while missing certificates are cached
 * (each block moves the chain clock), the re-simulated renewSigner reverts AttestationStale and the revert
 * mapping answers with registration's line and advice.
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

describe('adversary r4: signer renew, report goes stale while certificates are cached', () => {
  it('the AttestationStale revert after caching still says "Not renewed"', async () => {
    // 1797 s old: inside Celo's 1800 s when planned; the two certificate blocks (2 s each here) push it past.
    const { doc, publicKey } = attestation(w, { ageSec: 1797 });
    activeSigner(signerFromPublicKey(publicKey));
    w.files.set('att.bin', doc);
    const code = await w.cli('signer', 'renew', '--attestation', 'att.bin', '--yes');
    expect(code).toBe(1);
    expect(w.chain.sent.length).toBeGreaterThan(0); // certificates were cached before the refusal
    expect(w.err[0]).toMatch(/^Not renewed: /);
  });
});
