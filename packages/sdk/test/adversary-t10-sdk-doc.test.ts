import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOYMENTS, originHash } from '@attessa/core';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { createAttestClient } from '../src/client.ts';
import type { Network } from '../src/types.ts';
import { FakeChain } from './fakes/chain.ts';

/**
 * Adversary pass on the ClientOptions.registry doc (types.ts): "EnclaveRegistry for a chain whose
 * deployments.ts entry has no registry yet (mainnet before T30). Ignored whenever the RPC's chain has a
 * pinned registry, including network 'local' on a fork that keeps a deployed chain's id."
 * ClientOptions: "injection points for tests and for chains with no deployed registry."
 */

const OVERRIDE = '0x5fbdb2315678afecb367f032d93f642f64180aa3';

async function resolveWith(network: Network, chainId: number, registry: string) {
  const chain = new FakeChain({ chainId, registry });
  const origin = network === 'local' ? 'http://localhost:9999' : 'https://risk.example';
  chain.addEndpoint(7n, origin, originHash(origin), '0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2');
  chain.advance(5);
  const wk = { v: '1', chainId: String(chainId), registry, agentId: '7', origin, resources: [{ path: '/v1/evaluate', method: 'POST' }] };
  const fetch = (async () => new Response(JSON.stringify(wk), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  const limits = { maxAmountPerCall: 1n, dailyCap: 1n };
  const dataDir = mkdtempSync(join(tmpdir(), 'attessa-adv-t10-doc-'));
  try {
    const c = createAttestClient(
      { network, account: privateKeyToAccount(generatePrivateKey()), limits: { usdc: limits, usat: limits }, asset: 'usdc', dataDir },
      { registry: OVERRIDE, transport: chain.transport(), fetch },
    );
    return await c.resolveEndpoint(`${origin}/v1/evaluate`).then(
      (r) => ({ registry: (r as { registry?: string }).registry ?? 'resolved' }),
      (e: Error & { code?: string }) => ({ refused: e.code ?? e.message }),
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('sdk: adversary T10 sdk-doc, ClientOptions.registry is used exactly where the doc says', () => {
  it('celo (mainnet before T30, no pin): options.registry is used', async () => {
    expect(DEPLOYMENTS.celo.enclaveRegistry).toBeNull();
    expect(await resolveWith('celo', 42220, OVERRIDE)).toEqual({ registry: OVERRIDE });
  });

  it('local on a mainnet fork (42220, no pin): options.registry is used', async () => {
    expect(await resolveWith('local', 42220, OVERRIDE)).toEqual({ registry: OVERRIDE });
  });

  it('local on a plain anvil chain (31337, "a chain with no deployed registry"): options.registry is used', async () => {
    expect(await resolveWith('local', 31337, OVERRIDE)).toEqual({ registry: OVERRIDE });
  });
});
