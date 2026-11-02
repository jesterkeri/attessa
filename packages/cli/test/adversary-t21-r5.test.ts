import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { originHash } from '@attessa/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { RpcUnavailable } from '../src/rpc.ts';
import { AGENT, ORIGIN, onboarded, world, type World } from './harness.ts';

// T21 adversary r5. Seller and owner commands still let a raw RpcUnavailable from an unwrapped chain read
// (eth_gasPrice, eth_getBlockByNumber) escape to run(), which prints the generic "Unexpected error" line.
//
// FLOWS §5 row 26: `attessa agent register` ... On failure: `insufficient_gas_funds` / `rpc_unavailable`.
// FLOWS §8 "rpc unavailable": "Can't reach Celo at {rpc}. Nothing was signed." / "Retry or set another `--rpc`."
//   machine code `rpc_unavailable`.
// Every failure here happens before anything is signed, so the FLOWS row is true as written.

const FORNO = 'https://forno.celo-sepolia.celo-testnet.org';
const RPC_ROW = [`Can't reach Celo at ${FORNO}. Nothing was signed.`, 'Retry or set another `--rpc`.'];
const SRC = 'https://github.com/acme/risk/commit/a1b2c3d';

let w: World;
beforeEach(() => {
  w = world();
});

/** The RPC answers everything except `method`, which fails as a dropped connection (what HttpRpc throws). */
function dropAt(method: string): void {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[]) => {
    if (m === method) throw new RpcUnavailable(`${m}: connect ECONNREFUSED`);
    return orig(m, p);
  };
}

describe('T21 adversary r5: seller/owner commands keep the FLOWS rpc_unavailable row', () => {
  it('agent register: the RPC drops at eth_gasPrice -> FLOWS row 26 rpc_unavailable, not "Unexpected error"', async () => {
    w.chain.owners.delete(AGENT);
    w.chain.nextAgentId = AGENT;
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    dropAt('eth_gasPrice');
    expect(await w.cli('agent', 'register', '--name', 'Acme risk check', '--uri', 'https://example.org/agent.json')).toBe(1);
    expect(w.err).toEqual(RPC_ROW);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('agent register --json: the RPC drops at eth_gasPrice -> error code rpc_unavailable', async () => {
    dropAt('eth_gasPrice');
    expect(await w.cli('agent', 'register', '--name', 'Acme risk check', '--uri', 'https://example.org/agent.json', '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'rpc_unavailable' });
  });

  it('revoke release (J4): the RPC drops at eth_getBlockByNumber -> FLOWS rpc_unavailable, not "Unexpected error"', async () => {
    onboarded(w);
    w.chain.approveRelease(AGENT, w.rid, SRC);
    const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
    w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    dropAt('eth_getBlockByNumber');
    expect(await w.cli('revoke', 'release', w.rid)).toBe(1);
    expect(w.err).toEqual(RPC_ROW);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('status --agent (a read): the RPC drops at eth_getBlockByNumber -> FLOWS rpc_unavailable, not "Unexpected error"', async () => {
    onboarded(w);
    dropAt('eth_getBlockByNumber');
    expect(await w.cli('status', '--agent', AGENT.toString())).toBe(1);
    expect(w.err).toEqual(RPC_ROW);
  });
});
