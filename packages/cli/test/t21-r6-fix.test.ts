import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeErrorResult, type Address } from 'viem';
import { originHash } from '@attessa/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { hintPlan, parseAttestation } from '../src/attestation.ts';
import { RpcError } from '../src/rpc.ts';
import { AGENT, ORIGIN, attestation, onboarded, world, type World } from './harness.ts';

// T21 adversary r6 fixes beyond the adversary's own tests: a revert's free reply text from the node is never printed
// (only ABI-decoded names and reasons), and a later step's revert after an earlier transaction landed keeps its line
// without the closing "Nothing was sent.".

let w: World;
beforeEach(() => {
  w = world();
});

function failAt(method: string, err: () => Error, afterSends = 0): void {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[]) => {
    if (m === method && w.chain.sent.length >= afterSends) throw err();
    return orig(m, p);
  };
}

function cacheCerts(doc: Buffer, n: number): void {
  for (const c of hintPlan(parseAttestation(doc)).certs.slice(0, n)) w.chain.certs.set(c.certHash, { notAfter: w.chain.timestamp + 3600n, parent: c.parentCertHash });
}

function revokeSignerSetup(): string[] {
  onboarded(w);
  const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
  w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
  w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
  return ['revoke', 'signer', signer];
}

describe('a simulated revert prints no free text from the node', () => {
  it('a revert with no data: the generic line without the reply text', async () => {
    const argv = revokeSignerSetup();
    failAt('eth_estimateGas', () => new RpcError(3, 'execution reverted: NODE-REPLY-TEXT', '0x'));
    expect(await w.cli(...argv)).toBe(1);
    expect(w.chain.sent).toHaveLength(0);
    expect(w.err).toEqual(['The transaction would revert. Nothing was sent.']);
  });

  it('a -32000 "execution reverted" reply is still a revert, not the rpc row', async () => {
    const argv = revokeSignerSetup();
    failAt('eth_estimateGas', () => new RpcError(-32000, 'execution reverted NODE-REPLY-TEXT', undefined));
    expect(await w.cli(...argv)).toBe(1);
    expect(w.err).toEqual(['The transaction would revert. Nothing was sent.']);
  });

  it('an undecodable revert keeps only its name', async () => {
    const argv = revokeSignerSetup();
    failAt('eth_estimateGas', () => new RpcError(3, 'execution reverted NODE-REPLY-TEXT', '0xdeadbeef'));
    expect(await w.cli(...argv)).toBe(1);
    expect(w.err).toEqual(['The transaction would revert (unknown). Nothing was sent.']);
  });

  it('an Error(string) reason decoded from the ABI is printed, escaped', async () => {
    const argv = revokeSignerSetup();
    const data = encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'reason' }] }], errorName: 'Error', args: ['paused\x1b[2J'] });
    failAt('eth_estimateGas', () => new RpcError(3, 'execution reverted NODE-REPLY-TEXT', data));
    expect(await w.cli(...argv)).toBe(1);
    expect(w.err).toEqual(['The transaction would revert: paused\\x1b[2J. Nothing was sent.']);
  });
});

describe('after an earlier transaction of the command landed', () => {
  it('signer register: the 2nd step reverts at re-simulation -> the revert line without "Nothing was sent."', async () => {
    onboarded(w);
    const { doc } = attestation(w);
    cacheCerts(doc, 3);
    w.files.set('att.bin', doc);
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    failAt('eth_estimateGas', () => new RpcError(3, 'execution reverted', '0x'), 1);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--origin', ORIGIN, '--yes', '--json')).toBe(1);
    expect(w.chain.sent).toHaveLength(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'reverted', message: 'The transaction would revert.' });
  });
});
