import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { originHash } from '@attessa/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { hintPlan, parseAttestation } from '../src/attestation.ts';
import { RpcError } from '../src/rpc.ts';
import { AGENT, ORIGIN, attestation, onboarded, world, type World } from './harness.ts';

// T21 adversary r6. `simulate` (eth_call + eth_estimateGas, a chain read made before anything is signed) still reads
// every JSON-RPC error reply as a contract revert. A rate limit or an internal error from the node is then printed as
// "The transaction would revert: <the node's reply text>. Nothing was sent." instead of the rpc row, and after an
// earlier transaction of the same command was sent, "Nothing was sent." is printed although one was.
//
// FLOWS §8 "rpc unavailable": "Can't reach Celo at {rpc}. Nothing was signed." / "Retry or set another `--rpc`."
//   machine code `rpc_unavailable`.
// FLOWS §5 row 26: `attessa agent register` ... On failure: `insufficient_gas_funds` / `rpc_unavailable`.
// FLOWS §5 row 18: `attessa signer register` cache CA certs; failure `cert_expired` / `gas_too_low` (no generic revert).
// T21 r5 change (tx.ts rpcRow): "a JSON-RPC error reply that isn't a contract revert (a rate limit, an internal error)"
//   on a read before signing is the rpc row, and "The reply's text is never printed."

const FORNO = 'https://forno.celo-sepolia.celo-testnet.org';
const RPC_ROW = [`Can't reach Celo at ${FORNO}. Nothing was signed.`, 'Retry or set another `--rpc`.'];

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
// A node's reply text can carry anything the node chose to put there; this one is recognisable.
const rateLimited = () => new RpcError(-32005, 'limit exceeded for key NODE-REPLY-TEXT', undefined);
const internal = () => new RpcError(-32603, 'internal error NODE-REPLY-TEXT', undefined);

function cacheCerts(doc: Buffer, n: number): void {
  for (const c of hintPlan(parseAttestation(doc)).certs.slice(0, n)) w.chain.certs.set(c.certHash, { notAfter: w.chain.timestamp + 3600n, parent: c.parentCertHash });
}

describe('T21 adversary r6: simulate reads a non-revert JSON-RPC error as a revert', () => {
  it('revoke signer: eth_estimateGas answers a rate-limit error -> FLOWS §8 rpc row, not "would revert: <reply>"', async () => {
    onboarded(w);
    const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
    w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    failAt('eth_estimateGas', rateLimited);
    expect(await w.cli('revoke', 'signer', signer)).toBe(1);
    expect(w.chain.sent).toHaveLength(0);
    expect(w.err.join('\n')).not.toContain('NODE-REPLY-TEXT');
    expect(w.err).toEqual(RPC_ROW);
  });

  it('agent register --json: eth_estimateGas answers an internal error -> FLOWS §5 row 26 rpc_unavailable, not `reverted`', async () => {
    w.chain.owners.delete(AGENT);
    w.chain.nextAgentId = AGENT;
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    failAt('eth_estimateGas', internal);
    expect(await w.cli('agent', 'register', '--name', 'Acme risk check', '--uri', 'https://example.org/agent.json', '--json')).toBe(1);
    expect(w.chain.sent).toHaveLength(0);
    const out = JSON.parse(w.out.at(-1)!);
    expect(out.message).not.toContain('NODE-REPLY-TEXT');
    expect(out).toMatchObject({ ok: false, error: 'rpc_unavailable', message: RPC_ROW[0] });
  });

  it('signer register, 2 transactions: the 2nd one\'s eth_estimateGas is rate-limited after the 1st was sent -> never "Nothing was sent"', async () => {
    onboarded(w);
    const { doc } = attestation(w);
    cacheCerts(doc, 3);
    w.files.set('att.bin', doc);
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    failAt('eth_estimateGas', rateLimited, 1);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--origin', ORIGIN, '--yes')).toBe(1);
    expect(w.chain.sent).toHaveLength(1);
    const said = w.err.join('\n');
    expect(said).not.toContain('NODE-REPLY-TEXT');
    expect(said).not.toMatch(/Nothing was (sent|signed)/);
  });

  it('signer register, 2 transactions: the 2nd one reverts at re-simulation after the 1st was sent -> never "Nothing was sent"', async () => {
    onboarded(w);
    const { doc } = attestation(w);
    cacheCerts(doc, 3);
    w.files.set('att.bin', doc);
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    // A plain revert with no data (e.g. state changed between plan and send): the generic `reverted` line.
    failAt('eth_estimateGas', () => new RpcError(3, 'execution reverted', '0x'), 1);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--origin', ORIGIN, '--yes')).toBe(1);
    expect(w.chain.sent).toHaveLength(1);
    expect(w.err.join('\n')).not.toMatch(/Nothing was (sent|signed)/);
  });
});
