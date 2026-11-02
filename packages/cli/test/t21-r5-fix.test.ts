import { signerFromPublicKey } from '@attessa/core';
import { originHash } from '@attessa/core';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, type Address } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { hintPlan, parseAttestation } from '../src/attestation.ts';
import { RpcError, RpcUnavailable } from '../src/rpc.ts';
import { AGENT, ORIGIN, attestation, onboarded, world, type World } from './harness.ts';

// T21 adversary r5 fixes beyond the adversary's own tests: the signer commands' unwrapped head/gasPrice reads, a
// JSON-RPC error reply (not a revert) from any read, and the care point: once a transaction is signed, a dropped RPC
// never prints the rpc row's "Nothing was signed."

const FORNO = 'https://forno.celo-sepolia.celo-testnet.org';
const RPC_ROW = [`Can't reach Celo at ${FORNO}. Nothing was signed.`, 'Retry or set another `--rpc`.'];
// T21 r10: after an earlier transaction landed, the rpc row without its "Nothing was signed." (re-running skips what
// landed); a sent transaction whose receipt a dropped RPC hides is the sent-unconfirmed row with its hash.
const DROPPED_AFTER_SIGNING = [`Can't reach Celo at ${FORNO}.`, 'Retry or set another `--rpc`.'];

let w: World;
beforeEach(() => {
  w = world();
});

/** `method` fails with `err()` once `afterSends` transactions have been broadcast; everything else is answered. */
function failAt(method: string, err: () => Error, afterSends = 0): void {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[]) => {
    if (m === method && w.chain.sent.length >= afterSends) throw err();
    return orig(m, p);
  };
}
const drop = (m: string) => () => new RpcUnavailable(`${m}: connect ECONNREFUSED`);
const rateLimited = () => new RpcError(-32005, 'limit exceeded', undefined);

function cacheCerts(doc: Buffer, n: number): void {
  for (const c of hintPlan(parseAttestation(doc)).certs.slice(0, n)) w.chain.certs.set(c.certHash, { notAfter: w.chain.timestamp + 3600n, parent: c.parentCertHash });
}

/** A signer-register run with `cached` of 4 certificates cached, sending with the operator key. */
function registerSetup(cached: number): string[] {
  onboarded(w);
  const { doc } = attestation(w);
  cacheCerts(doc, cached);
  w.files.set('att.bin', doc);
  w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
  return ['signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--origin', ORIGIN, '--yes'];
}

/** A live signer and its attestation, ready for `signer renew --attestation att.bin`. */
function renewSetup(): string[] {
  onboarded(w);
  const { doc, publicKey } = attestation(w);
  cacheCerts(doc, 4);
  w.chain.addSigner(signerFromPublicKey(publicKey).toLowerCase() as Address, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
  w.files.set('att.bin', doc);
  w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
  return ['signer', 'renew', '--attestation', 'att.bin', '--yes'];
}

describe('signer commands: reads before signing keep the FLOWS rpc_unavailable row', () => {
  it('signer register: the RPC drops at eth_getBlockByNumber', async () => {
    const argv = registerSetup(4);
    failAt('eth_getBlockByNumber', drop('eth_getBlockByNumber'));
    expect(await w.cli(...argv)).toBe(1);
    expect(w.err).toEqual(RPC_ROW);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('signer register: the RPC drops at eth_gasPrice', async () => {
    const argv = registerSetup(4);
    failAt('eth_gasPrice', drop('eth_gasPrice'));
    expect(await w.cli(...argv)).toBe(1);
    expect(w.err).toEqual(RPC_ROW);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('signer renew: the RPC drops at eth_getBlockByNumber', async () => {
    const argv = renewSetup();
    failAt('eth_getBlockByNumber', drop('eth_getBlockByNumber'));
    expect(await w.cli(...argv)).toBe(1);
    expect(w.err).toEqual(RPC_ROW);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('signer renew: the RPC drops at eth_gasPrice', async () => {
    const argv = renewSetup();
    failAt('eth_gasPrice', drop('eth_gasPrice'));
    expect(await w.cli(...argv)).toBe(1);
    expect(w.err).toEqual(RPC_ROW);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('the first transaction: the RPC drops at eth_getTransactionCount or eth_maxPriorityFeePerGas, before signing', async () => {
    for (const m of ['eth_getTransactionCount', 'eth_maxPriorityFeePerGas']) {
      w = world();
      const argv = registerSetup(4);
      failAt(m, drop(m));
      expect(await w.cli(...argv)).toBe(1);
      expect(w.err).toEqual(RPC_ROW);
      expect(w.chain.sent).toHaveLength(0);
    }
  });
});

describe('a JSON-RPC error reply that is not a revert is the rpc_unavailable row', () => {
  it('revoke signer: eth_call answers a rate-limit error', async () => {
    onboarded(w);
    const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
    w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    failAt('eth_call', rateLimited);
    expect(await w.cli('revoke', 'signer', signer)).toBe(1);
    expect(w.err).toEqual(RPC_ROW);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('agent transfer: ownerOf answers a rate-limit error -> rpc_unavailable, not unknown_agent', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    failAt('eth_call', rateLimited);
    expect(await w.cli('agent', 'transfer', '--agent', '412', '--to', w.operator, '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'rpc_unavailable' });
  });

  it('a revert is still the contract\'s answer: ownerOf of a missing agent stays unknown_agent', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expect(await w.cli('agent', 'transfer', '--agent', '999', '--to', w.operator, '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'unknown_agent' });
  });

  it('status --agent: eth_getBlockByNumber answers an error', async () => {
    onboarded(w);
    failAt('eth_getBlockByNumber', rateLimited);
    expect(await w.cli('status', '--agent', '412')).toBe(1);
    expect(w.err).toEqual(RPC_ROW);
  });

  it('agent register: eth_gasPrice answers an error', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    failAt('eth_gasPrice', rateLimited);
    expect(await w.cli('agent', 'register', '--name', 'Acme risk check', '--uri', 'https://example.org/agent.json')).toBe(1);
    expect(w.err).toEqual(RPC_ROW);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('connect: eth_chainId answers an error', async () => {
    failAt('eth_chainId', rateLimited);
    expect(await w.cli('status', '--agent', '412')).toBe(1);
    expect(w.err).toEqual(RPC_ROW);
  });
});

describe('after a transaction is signed, a dropped RPC never says "Nothing was signed"', () => {
  it('agent register: the RPC drops while polling for the receipt', async () => {
    w.chain.owners.delete(AGENT);
    w.chain.nextAgentId = AGENT;
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    failAt('eth_getTransactionReceipt', drop('eth_getTransactionReceipt'));
    expect(await w.cli('agent', 'register', '--name', 'Acme risk check', '--uri', 'https://example.org/agent.json')).toBe(1);
    expect(w.chain.sent).toHaveLength(1);
    expect(w.err).toEqual([
      `Lost the connection to Celo after sending register (tx ${keccak256(w.chain.sent[0]!)}); it may still land.`,
      'Check the tx on a Celo explorer before running again.',
    ]);
  });

  it('signer register, 2 transactions: the RPC drops at the second one\'s simulation, after the first was sent', async () => {
    const argv = registerSetup(3);
    failAt('eth_call', drop('eth_call'), 1);
    expect(await w.cli(...argv)).toBe(1);
    expect(w.chain.sent).toHaveLength(1);
    expect(w.err).toEqual(DROPPED_AFTER_SIGNING);
  });

  it('signer register, 2 transactions: the RPC drops at the second one\'s eth_gasPrice', async () => {
    const argv = registerSetup(3);
    failAt('eth_gasPrice', drop('eth_gasPrice'), 1);
    expect(await w.cli(...argv)).toBe(1);
    expect(w.chain.sent).toHaveLength(1);
    expect(w.err).toEqual(DROPPED_AFTER_SIGNING);
  });

  it('signer register: the RPC drops at the read after the last transaction landed', async () => {
    const argv = registerSetup(4);
    failAt('eth_call', drop('eth_call'), 1);
    expect(await w.cli(...argv)).toBe(1);
    expect(w.chain.sent).toHaveLength(1);
    expect(w.err).toEqual(DROPPED_AFTER_SIGNING);
  });

  it('signer register --json after a send: rpc_unavailable without "Nothing was signed"', async () => {
    const argv = registerSetup(4);
    failAt('eth_call', drop('eth_call'), 1);
    expect(await w.cli(...argv, '--json')).toBe(1);
    const out = JSON.parse(w.out.at(-1)!);
    expect(out).toMatchObject({ ok: false, error: 'rpc_unavailable', next: 'Retry or set another `--rpc`.' });
    expect(out.message).not.toContain('Nothing was signed');
  });
});
