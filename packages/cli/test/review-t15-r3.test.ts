import { originHash, signerFromPublicKey } from '@attessa/core';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, ORIGIN, attestation, onboarded, world, type World } from './harness.ts';

/**
 * Fix for adversary T15 r3: `enclave start --port` must be the network's own SPEC §5 socat port, checked
 * against the real port map (no test seam). Also: renew refusals it shares with registration say "Not renewed".
 */

let w: World;
beforeEach(() => {
  w = world();
  w.socatPorts = undefined; // the production map: mainnet 5005, Sepolia 5007, test build 5006
  w.files.set('/srv/risk/build/risk.eif', Buffer.from('eif'));
});

describe('seller: enclave start --port is pinned per network (SPEC §5)', () => {
  for (const [args, want] of [
    [['--port', '5005'], '--port must be 5007 on sepolia.'],
    [['--network', 'sepolia', '--port', '5006'], '--port must be 5007 on sepolia.'],
    [['--network', 'mainnet', '--port', '5007'], '--port must be 5005 on mainnet.'],
    [['--network', 'mainnet', '--test-build', '--port', '5005'], '--port must be 5006 with --test-build.'],
  ] as const) {
    it(`${args.join(' ')}: refused before anything starts`, async () => {
      expect(await w.cli('enclave', 'start', '--agent', '412', '--origin', ORIGIN, ...args)).toBe(1);
      expect(w.err[0]).toBe(want);
      expect(w.runs).toHaveLength(0);
    });
  }

  // Sepolia's 5007, not mainnet's 5005: adversary-t15-r3 listens on 5005 and may run in parallel.
  it("the network's own port passes the check and starts that network's CID", async () => {
    await w.cli('enclave', 'start', '--network', 'sepolia', '--agent', '412', '--origin', ORIGIN, '--port', '5007');
    expect(w.runs.map((r) => r.args.at(-1))).toEqual(['17']);
  });
});

describe('seller: signer renew refusals shared with registration say "Not renewed" (FLOWS §8 R: renew refused)', () => {
  beforeEach(() => {
    onboarded(w);
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
  });

  function activeSigner(signer: Address, releaseId = w.rid): void {
    w.chain.signers.set(signer, {
      agentId: AGENT, releaseId, originHash: originHash(ORIGIN), operator: w.operator,
      registeredAt: w.chain.timestamp - 518_400n, expiresAt: w.chain.timestamp + 86_400n, status: 1, attestationHash: `0x${'00'.repeat(32)}`,
    });
  }

  async function renew(doc: Buffer): Promise<number> {
    w.files.set('att.bin', doc);
    return w.cli('signer', 'renew', '--attestation', 'att.bin', '--yes');
  }

  it('debug-mode PCRs', async () => {
    const { doc, publicKey } = attestation(w, { pcrs: [Buffer.alloc(48), Buffer.alloc(48), Buffer.alloc(48)] });
    activeSigner(signerFromPublicKey(publicKey));
    expect(await renew(doc)).toBe(1);
    expect(w.err).toEqual(["Not renewed: the machine was started in debug mode, which AWS doesn't sign for.", 'Run `attessa signer renew` on the machine that holds this key.']);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('a release the owner no longer approves', async () => {
    const { doc, publicKey } = attestation(w);
    activeSigner(signerFromPublicKey(publicKey));
    w.chain.releases.set(`${AGENT}:${w.rid}`, 3);
    expect(await renew(doc)).toBe(1);
    expect(w.err[0]).toBe(`Not renewed: this machine runs a build agent 412 hasn't approved (release ${w.rid.slice(0, 6)}…${w.rid.slice(-2)}).`);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('a binding for another agent', async () => {
    const { doc, publicKey } = attestation(w, { agentId: 7n });
    activeSigner(signerFromPublicKey(publicKey));
    expect(await renew(doc)).toBe(1);
    expect(w.err[0]).toBe('Not renewed: the attestation was made for agent 7.');
    expect(w.chain.sent).toHaveLength(0);
  });
});
