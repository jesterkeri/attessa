import { readFileSync } from 'node:fs';
import {
  DEPLOYMENTS,
  deploymentForChainId,
  normalizeOrigin,
  originHash,
  type AssetKey,
  type Deployment,
  type PinnedAsset,
} from '@attessa/core';
import type { Address, Hex } from 'viem';

/** SPEC §6.6 `gateway.config.json`. No private key, ever. The facilitator API key comes from env only. */
export interface GatewayConfigFile {
  network: 'celo' | 'celo-sepolia' | 'local';
  /** Required for `local` (the chain id the fork reports); must match the network otherwise. */
  chainId?: number;
  registry: string;
  agentId: string;
  origin: string;
  payTo: string;
  /** Atomic price per pinned asset key (SPEC §6.6 default 20000). */
  prices?: Partial<Record<AssetKey, string>>;
  sellerHostUrl: string;
  facilitatorUrl: string;
  /** Header that carries the API key, as `<name>: <prefix><key>`. Default `Authorization: Bearer <key>`. */
  facilitatorAuthHeader?: string;
  facilitatorAuthPrefix?: string;
  dbPath: string;
  listen?: { host?: string; port?: number };
  timeouts?: Partial<Timeouts>;
  unsettledLimitPerHour?: number;
  /** Directory holding `privacy.txt`, `terms.txt`, `security.txt`; the routes 404 without it. */
  staticDir?: string;
}

export interface Timeouts {
  /** §6.2 step 8. */
  executeMs: number;
  /** §6.2 step 11. */
  settleMs: number;
  /** §6.2 step 11: receipt poll after 2xx `success:true`. */
  receiptPollMs: number;
  receiptPollIntervalMs: number;
  /** §6.2 step 11: cap on one 429 `Retry-After` wait. */
  maxRetryAfterMs: number;
  /** §6.2 step 7. */
  signerRefreshMs: number;
  /** §6.3. */
  reconcileIntervalMs: number;
  verifyMs: number;
  sellerHostMs: number;
}

export interface GatewayConfig {
  network: GatewayConfigFile['network'];
  chainId: number;
  x402Network: string;
  registry: Address;
  agentId: bigint;
  origin: string;
  originHash: Hex;
  payTo: Address;
  /** Offered assets, in the order they appear in `accepts[]`. */
  assets: Array<{ key: AssetKey; pin: PinnedAsset; amount: string }>;
  sellerHostUrl: string;
  facilitatorUrl: string;
  facilitatorAuthHeader: string;
  facilitatorAuthPrefix: string;
  dbPath: string;
  listen: { host: string; port: number };
  timeouts: Timeouts;
  unsettledLimitPerHour: number;
  staticDir: string | null;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  executeMs: 20_000,
  settleMs: 15_000,
  receiptPollMs: 5_000,
  receiptPollIntervalMs: 500,
  maxRetryAfterMs: 5_000,
  signerRefreshMs: 60_000,
  reconcileIntervalMs: 5_000,
  verifyMs: 10_000,
  sellerHostMs: 5_000,
};

export const DEFAULT_PRICE = '20000';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;

export class ConfigError extends Error {}

function lowerAddress(name: string, v: unknown): Address {
  if (typeof v !== 'string' || !ADDRESS.test(v)) throw new ConfigError(`${name}: expected a 20-byte 0x address`);
  return v.toLowerCase() as Address;
}

export function parseConfig(raw: GatewayConfigFile): GatewayConfig {
  let deployment: Deployment;
  if (raw.network === 'local') {
    if (raw.chainId === undefined) throw new ConfigError('chainId: required for network local');
    deployment = deploymentForChainId(raw.chainId);
  } else if (raw.network === 'celo' || raw.network === 'celo-sepolia') {
    deployment = DEPLOYMENTS[raw.network];
    if (raw.chainId !== undefined && raw.chainId !== deployment.chainId) {
      throw new ConfigError(`chainId ${raw.chainId} does not match network ${raw.network}`);
    }
  } else {
    throw new ConfigError('network: expected celo, celo-sepolia or local');
  }
  if (typeof raw.agentId !== 'string' || !UINT.test(raw.agentId)) throw new ConfigError('agentId: expected a decimal string');
  const origin = normalizeOrigin(raw.origin, { local: raw.network === 'local' });
  const prices = raw.prices ?? { usdc: DEFAULT_PRICE };
  const assets: GatewayConfig['assets'] = [];
  for (const key of Object.keys(prices) as AssetKey[]) {
    const pin = deployment.assets[key];
    if (!pin) throw new ConfigError(`prices.${key}: no pinned asset on ${raw.network}`);
    const amount = prices[key];
    if (typeof amount !== 'string' || !UINT.test(amount) || amount === '0') {
      throw new ConfigError(`prices.${key}: expected a positive atomic amount as a decimal string`);
    }
    assets.push({ key, pin: { ...pin, address: pin.address.toLowerCase() as Address }, amount });
  }
  if (assets.length === 0) throw new ConfigError('prices: at least one asset');
  return {
    network: raw.network,
    chainId: deployment.chainId,
    x402Network: deployment.x402Network,
    registry: lowerAddress('registry', raw.registry),
    agentId: BigInt(raw.agentId),
    origin,
    originHash: originHash(origin),
    payTo: lowerAddress('payTo', raw.payTo),
    assets,
    sellerHostUrl: raw.sellerHostUrl.replace(/\/+$/, ''),
    facilitatorUrl: raw.facilitatorUrl.replace(/\/+$/, ''),
    facilitatorAuthHeader: raw.facilitatorAuthHeader ?? 'Authorization',
    facilitatorAuthPrefix: raw.facilitatorAuthPrefix ?? 'Bearer ',
    dbPath: raw.dbPath,
    listen: { host: raw.listen?.host ?? '127.0.0.1', port: raw.listen?.port ?? 8080 },
    timeouts: { ...DEFAULT_TIMEOUTS, ...raw.timeouts },
    unsettledLimitPerHour: raw.unsettledLimitPerHour ?? 5,
    staticDir: raw.staticDir ?? null,
  };
}

export function loadConfig(path: string): GatewayConfig {
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')) as GatewayConfigFile);
}

/** Default public RPC per network when `RPC_URL` is unset (S8: Forno serves the state depth §6.2 step 9 needs). */
export function defaultRpcUrl(cfg: GatewayConfig): string | null {
  if (cfg.chainId === 42220) return 'https://forno.celo.org';
  if (cfg.chainId === 11142220) return 'https://forno.celo-sepolia.celo-testnet.org';
  return null;
}
