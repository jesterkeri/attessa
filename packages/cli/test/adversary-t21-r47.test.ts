import { originHash } from '@attessa/core';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY } from './fake-chain.ts';
import { AGENT, ORIGIN, onboarded, sellerHost, world, type World } from './harness.ts';

/**
 * T21 adversary r47: the owner rotated the endpoint's operator (retireEndpoint, then addEndpoint with a new operator;
 * SPEC §3.4 addEndpoint "overwrites a retired record"). The running key's signer still carries the old operator, so it
 * is Inert (FLOWS §7 "endpoint operator changed (OPERATOR_MISMATCH)"; SPEC §3.4 checkSigner 7 "rotating the operator
 * evicts old signers"), and renewSigner can never pass for it (SPEC §3.4 renewSigner 2: `e.operator == s.operator`).
 * The new operator runs the commands from the endpoint's own operator wallet.
 */

let w: World;
let stops: Array<() => Promise<void>> = [];
beforeEach(() => {
  w = world();
  onboarded(w); // endpoint risk.example, operator = w.operator (the new one)
});
afterEach(async () => {
  for (const s of stops) await s();
  stops = [];
});

const OLD_OPERATOR = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;

/** The running enclave's key, registered earlier by the old operator, Active and 1 day from expiry. */
async function rotated() {
  const h = await sellerHost(w);
  stops.push(h.stop);
  const { EnclaveClient, TcpEnclaveTransport } = await import('@attessa/seller-host');
  await new EnclaveClient(new TcpEnclaveTransport(h.enclavePort)).configureOrAttest(
    { chainId: String(w.chain.chainId), registry: REGISTRY, agentId: '412', origin: ORIGIN, rpcAllowedChains: [String(w.chain.chainId)] },
    2000,
  );
  w.chain.signers.set(h.enclave.signer, {
    agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: OLD_OPERATOR,
    registeredAt: w.chain.timestamp - 518_400n, expiresAt: w.chain.timestamp + 86_400n, status: 1, attestationHash: `0x${'00'.repeat(32)}`,
  });
  w.env.ATTESSA_PRIVATE_KEY = w.operatorKey; // the endpoint's current operator
  return h;
}

describe('T21 adversary r47: signer renew|register after the endpoint operator was rotated', () => {
  it('signer renew from the endpoint operator wallet does not say that wallet is not the operator', async () => {
    const h = await rotated();
    expect(w.chain.endpoints.get(originHash(ORIGIN))!.operator).toBe(w.operator);
    expect(await w.cli('signer', 'renew', '--seller-host', h.url)).toBe(1);
    // Wrong state: the sender IS the endpoint's operator; the signer is one another operator registered.
    expect(w.err[0]).not.toContain(`${w.operator} isn't the operator`);
    // FLOWS.md:832 one next action: re-running from the wallet it already ran from cannot help.
    expect(w.err[1]).not.toBe('Run from the operator wallet set in `attessa endpoint add`.');
    expect(w.chain.sent).toHaveLength(0);
  });

  it('signer register for that running key does not send the operator to signer renew, which cannot pass', async () => {
    const h = await rotated();
    expect(await w.cli('signer', 'register', '--agent', '412', '--fresh', '--seller-host', h.url)).toBe(1);
    // renewSigner step 2 requires e.operator == s.operator (SPEC §3.4), so `attessa signer renew` is not a next action
    // that can work for this key; FLOWS.md:832 needs one that does (a new key: enclave start, then signer register).
    expect(w.err.join('\n')).not.toMatch(/attessa signer renew/);
    expect(w.chain.sent).toHaveLength(0);
  });
});
