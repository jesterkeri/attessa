import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOYMENTS, originHash } from '@attessa/core';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { createAttestClient } from '../src/client.ts';
import { FakeChain } from './fakes/chain.ts';
import { makeWorld, type World } from './fakes/world.ts';

/**
 * Adversary pass on T10's deploy record. T10 pinned the real Celo Sepolia EnclaveRegistry in
 * packages/core/src/deployments.ts. SPEC §2.6: "The SDK uses only these pinned addresses", and the
 * `local` row: "the deployments entry and pins are copied from the network whose chain id the RPC
 * reports". The CLI made the pin authoritative over ATTESSA_REGISTRY (context.ts); the SDK still lets
 * `options.registry` override the pin (client.ts `opts.registry ?? deployment.enclaveRegistry`).
 *
 * Case 1 (celo-sepolia): resolveEndpoint returns the override registry, not the pin or a refusal.
 * Case 2 (local, Sepolia chain id): the fake serves a full endpoint, a gateway and a .well-known at a
 * registry that is not the pin, and options.registry names it. makeWorld() pins the Sepolia entry to
 * its fake registry, so the test puts the real T10 pin back before the client exists. Using only the
 * pin, the SDK finds no endpoint at 0x42Bf...92fF and stops before signing.
 */

let w: World;
afterEach(async () => w?.close());

// Read at import, before any makeWorld() swaps the pin.
const REAL_PIN = DEPLOYMENTS['celo-sepolia'].enclaveRegistry!;
const PIN = REAL_PIN.toLowerCase();
const DECOY = '0x5fbdb2315678afecb367f032d93f642f64180aa3';

describe('sdk: adversary T10 deploy record, the Sepolia pin is the only registry (SPEC §2.6)', () => {
  it('network celo-sepolia with options.registry set to a non-pinned registry does not resolve against it', async () => {
    const chain = new FakeChain({ chainId: 11142220, registry: DECOY });
    const origin = 'https://risk.example';
    const oh = originHash(origin);
    chain.addEndpoint(7n, origin, oh, '0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2');
    chain.advance(5);
    const wk = { v: '1', chainId: '11142220', registry: DECOY, agentId: '7', origin, resources: [{ path: '/v1/evaluate', method: 'POST' }] };
    const fetch = (async () => new Response(JSON.stringify(wk), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
    const limits = { maxAmountPerCall: 1n, dailyCap: 1n };
    const dataDir = mkdtempSync(join(tmpdir(), 'attessa-adv-t10-'));
    try {
      const c = createAttestClient(
        { network: 'celo-sepolia', account: privateKeyToAccount(generatePrivateKey()), limits: { usdc: limits, usat: limits }, asset: 'usdc', dataDir },
        { registry: DECOY, transport: chain.transport(), fetch },
      );
      const got = await c.resolveEndpoint(`${origin}/v1/evaluate`).catch((e: Error) => ({ refused: e.message }));
      // Either a refusal (nothing at the pin) or the pinned registry; never the override.
      expect(got).not.toMatchObject({ registry: DECOY });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('network local on a Sepolia-chain RPC with options.registry set to a non-pinned registry signs no payment', async () => {
    expect(PIN).toBe('0x42bf5cb440c3c321cb42b0f4c81c3c7435cb92ff');
    w = await makeWorld();
    // makeWorld() made the fake registry the pin; put the real T10 pin back (close() restores it again).
    (DEPLOYMENTS['celo-sepolia'] as { enclaveRegistry: string | null }).enclaveRegistry = REAL_PIN;
    expect(w.chain.chainId).toBe(11142220);
    expect(w.chain.registry).not.toBe(PIN);
    // A fresh client: network 'local', options.registry = the fake's (non-pinned) registry, same chain and gateway.
    const c = w.mkClient({ registry: w.chain.registry });
    const r = await c.payAndVerify(w.url, { body: w.body });
    expect(w.transferSignatures()).toBe(0);
    expect(r.outcome).toBe('stopped');
    expect(w.gw.paid).toHaveLength(0);
  });
});
