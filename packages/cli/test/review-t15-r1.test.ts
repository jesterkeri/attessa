import { originHash, signerFromPublicKey } from '@attessa/core';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, ORIGIN, attestation, onboarded, world, type World } from './harness.ts';

/**
 * Codex review r1 on T15, M1: `signer renew` applies registration's local checks (SPEC §3.4 renewSigner
 * step 3 repeats registerSigner steps 2-7) before it plans or sends any certificate-cache transaction.
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

describe('seller: attessa signer renew refuses before caching certificates', () => {
  it('a report dated 61 s ahead of the chain (MAX_FUTURE_SKEW is 60): refused, nothing sent', async () => {
    const { doc, publicKey } = attestation(w, { ageSec: -61 });
    activeSigner(signerFromPublicKey(publicKey));
    w.files.set('att.bin', doc);
    expect(await w.cli('signer', 'renew', '--attestation', 'att.bin', '--yes')).toBe(1);
    expect(w.err).toEqual(["Not renewed: the machine's report is dated ahead of Celo's clock.", 'Run `attessa signer renew` on the machine that holds this key.']);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('a report exactly 60 s ahead still renews', async () => {
    const { doc, publicKey } = attestation(w, { ageSec: -60 });
    activeSigner(signerFromPublicKey(publicKey));
    w.files.set('att.bin', doc);
    expect(await w.cli('signer', 'renew', '--attestation', 'att.bin', '--yes')).toBe(0);
  });

  it('a 65-byte key that is not 0x04-prefixed: refused with the CLI error, nothing sent', async () => {
    const good = privateKeyToAccount(generatePrivateKey()).publicKey;
    const { doc } = attestation(w, { publicKey: `0x05${good.slice(4)}` as Hex });
    w.files.set('att.bin', doc);
    expect(await w.cli('signer', 'renew', '--attestation', 'att.bin', '--yes')).toBe(1);
    expect(w.err[0]).toBe('Not renewed: the report carries no enclave key.');
    expect(w.chain.sent).toHaveLength(0);
  });
});
