import { originHash } from '@attessa/core';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, type Address } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { hintPlan, parseAttestation } from '../src/attestation.ts';
import { RpcError, RpcUnavailable } from '../src/rpc.ts';
import { AGENT, ORIGIN, attestation, onboarded, world, type World } from './harness.ts';

// T21 adversary r10 fixes for the seller writes: once a transaction is broadcast, a dropped RPC (the broadcast's
// reply or the receipt poll) is the sent-unconfirmed row with the full hash and one next action, never
// "Unexpected error" and never "Nothing was sent".

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

const EXPLORER = 'Check the tx on a Celo explorer before running again.';

function revokeSetup(): string[] {
  onboarded(w);
  const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
  w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
  w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
  return ['revoke', 'signer', signer, '--yes'];
}

describe('seller writes: a dropped RPC after the broadcast', () => {
  it('revoke signer: the broadcast reply is lost (the node got it): the hash and the explorer action', async () => {
    const argv = revokeSetup();
    const orig = w.chain.request.bind(w.chain);
    w.chain.request = async (m: string, p: unknown[]) => {
      const r = await orig(m, p);
      if (m === 'eth_sendRawTransaction') throw new RpcUnavailable('socket hang up');
      return r;
    };
    expect(await w.cli(...argv)).toBe(1);
    expect(w.chain.sent).toHaveLength(1);
    expect(w.err).toEqual([`Lost the connection to Celo after sending revokeSigner (tx ${keccak256(w.chain.sent[0]!)}); it may still land.`, EXPLORER]);
  });

  it('revoke signer --json: the receipt poll answers an error reply: tx_unconfirmed, no "Nothing was"', async () => {
    const argv = revokeSetup();
    failAt('eth_getTransactionReceipt', () => new RpcError(-32000, 'header not found', undefined));
    expect(await w.cli(...argv, '--json')).toBe(1);
    const out = JSON.parse(w.out.at(-1)!);
    expect(out).toMatchObject({ ok: false, error: 'tx_unconfirmed', next: EXPLORER });
    expect(out.message).toContain(keccak256(w.chain.sent[0]!));
    expect(out.message).not.toMatch(/Nothing was/);
  });

  it('signer register: the 2nd transaction\'s receipt poll drops: that transaction\'s hash, not the first\'s', async () => {
    onboarded(w);
    const { doc } = attestation(w);
    for (const c of hintPlan(parseAttestation(doc)).certs.slice(0, 3)) w.chain.certs.set(c.certHash, { notAfter: w.chain.timestamp + 3600n, parent: c.parentCertHash });
    w.files.set('att.bin', doc);
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    failAt('eth_getTransactionReceipt', () => new RpcUnavailable('connect ECONNREFUSED'), 2);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--origin', ORIGIN, '--yes')).toBe(1);
    expect(w.chain.sent).toHaveLength(2);
    expect(w.err).toEqual([`Lost the connection to Celo after sending registerSigner (tx ${keccak256(w.chain.sent[1]!)}); it may still land.`, EXPLORER]);
  });

  it('a refusal reply at the broadcast (not a dropped connection) is not read as "may still land"', async () => {
    const argv = revokeSetup();
    failAt('eth_sendRawTransaction', () => new RpcError(-32000, 'nonce too low', undefined));
    expect(await w.cli(...argv, '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'unexpected' });
  });
});
