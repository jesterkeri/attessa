import type { Address } from 'viem';

/** SPEC §2.6 and §3.5. One registry address per chain (NFR-6). */

export type Network = 'celo' | 'celo-sepolia' | 'local';
export type AssetKey = 'usdc' | 'usat';

export interface PinnedAsset {
  address: Address;
  /** EIP-712 domain name and version of the token (EIP-3009). */
  name: string;
  version: string;
}

export interface Deployment {
  chainId: number;
  /** x402 v2 CAIP-2 network. */
  x402Network: string;
  identityRegistry: Address;
  selfRegistry: Address;
  /** EnclaveRegistry. null until T10 (Sepolia) / T30 (mainnet) deploy it. */
  enclaveRegistry: Address | null;
  assets: Partial<Record<AssetKey, PinnedAsset>>;
}

export const DEPLOYMENTS: Record<Exclude<Network, 'local'>, Deployment> = {
  'celo-sepolia': {
    chainId: 11142220,
    x402Network: 'eip155:11142220',
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    selfRegistry: '0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379',
    enclaveRegistry: null,
    assets: {
      usdc: { address: '0x01c5c0122039549ad1493b8220cabedd739bc44e', name: 'USDC', version: '2' },
    },
  },
  celo: {
    chainId: 42220,
    x402Network: 'eip155:42220',
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    selfRegistry: '0xaC3DF9ABf80d0F5c020C06B04Cced27763355944',
    enclaveRegistry: null,
    assets: {
      usdc: { address: '0xceba9300f2b948710d2653dd7b07f33a8b32118c', name: 'USDC', version: '2' },
      usat: { address: '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771', name: 'Tether America USD', version: '1' },
    },
  },
};

/**
 * The deployment for a chain id. `--network local` uses this with the chain id its RPC reports
 * (an anvil fork keeps the forked id), so the entry and pins are copied from that network.
 */
export function deploymentForChainId(chainId: number): Deployment {
  const d = Object.values(DEPLOYMENTS).find((x) => x.chainId === chainId);
  if (!d) throw new Error(`no deployment for chain id ${chainId}`);
  return d;
}
