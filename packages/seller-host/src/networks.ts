/** SPEC §5: per-network host layout. No imports, so the unit renderer runs with plain node. */

export type SellerNetwork = 'mainnet' | 'sepolia' | 'test' | 'local';

/** SPEC §5 table: enclave CID, host socat port, seller-host HTTP port, gateway HTTP port. */
export const NETWORK_PORTS: Record<Exclude<SellerNetwork, 'local'>, { cid: number; socatPort: number; sellerPort: number; gatewayPort: number | null }> = {
  mainnet: { cid: 16, socatPort: 5005, sellerPort: 7070, gatewayPort: 8080 },
  sepolia: { cid: 17, socatPort: 5007, sellerPort: 7071, gatewayPort: 8081 },
  // The test-modified enclave (T17/T35 only): no seller-host or gateway of its own.
  test: { cid: 18, socatPort: 5006, sellerPort: 0, gatewayPort: null },
};

export const FORNO_URL = {
  mainnet: 'https://forno.celo.org',
  sepolia: 'https://forno.celo-sepolia.celo-testnet.org',
} as const;
