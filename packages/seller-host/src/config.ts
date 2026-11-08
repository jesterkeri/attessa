import { readFileSync } from 'node:fs';
import { DEPLOYMENTS, normalizeOrigin } from '@attessa/core';
import { validateBuyConfig, type BuyConfig } from './buy.ts';
import { FORNO_URL, NETWORK_PORTS } from './networks.ts';

/**
 * `seller-host.config.json`, one per network (SPEC §5). No private key: the agent wallet key for buy
 * payments comes only from env `AGENT_PRIVATE_KEY` (a 0600 file loaded by systemd), and only when buy
 * reads are configured.
 */

export interface SellerHostConfigFile {
  network: 'mainnet' | 'sepolia' | 'local';
  /** Required for `local` (the chain id the RPC reports); must match the network otherwise. */
  chainId?: number;
  registry: string;
  agentId: string;
  origin: string;
  /** Host socat TCP port that reaches the enclave. Required for `local`; fixed by SPEC §5 (5005 / 5007) otherwise. */
  enclavePort?: number;
  listen?: { host?: string; port?: number };
  /** Forno (or a local node for `local`). Default from the network. */
  fornoUrl?: string;
  /** The gateway's SQLite database, read-only, for the budget guard's settled revenue. */
  gatewayDbPath?: string;
  /** Where the budget guard keeps its daily counter. */
  stateDir: string;
  /** Paid chain reads through buy. Mainnet only; needs `gatewayDbPath`. No default: absent means Forno only. */
  buy?: { capabilityId: string; url: string; maxAmount: string; binary?: string; account?: string; home?: string; keystoreBackend?: 'system' | 'file' };
}

export interface LoadedConfig {
  network: SellerHostConfigFile['network'];
  chainId: number;
  registry: string;
  agentId: bigint;
  origin: string;
  enclavePort: number;
  listen: { host: string; port: number };
  fornoUrl: string;
  gatewayDbPath: string | null;
  stateDir: string;
  buy: BuyConfig | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEC = /^(0|[1-9][0-9]*)$/;

export function parseConfig(raw: unknown): LoadedConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('config: not an object');
  const c = raw as Partial<SellerHostConfigFile>;
  if (c.network !== 'mainnet' && c.network !== 'sepolia' && c.network !== 'local') throw new Error('config: network must be mainnet, sepolia or local');
  let chainId: number;
  if (c.network === 'local') {
    if (!Number.isSafeInteger(c.chainId)) throw new Error('config: chainId is required for local');
    chainId = c.chainId!;
  } else {
    chainId = DEPLOYMENTS[c.network === 'mainnet' ? 'celo' : 'celo-sepolia'].chainId;
    if (c.chainId !== undefined && c.chainId !== chainId) throw new Error(`config: chainId must be ${chainId} on ${c.network}`);
  }
  if (typeof c.registry !== 'string' || !ADDRESS.test(c.registry)) throw new Error('config: registry must be an address');
  if (typeof c.agentId !== 'string' || !DEC.test(c.agentId)) throw new Error('config: agentId must be a decimal string');
  if (typeof c.origin !== 'string') throw new Error('config: origin is required');
  const origin = normalizeOrigin(c.origin, { local: c.network === 'local' });
  if (origin !== c.origin) throw new Error(`config: origin must be normalised (${origin})`);
  if (typeof c.stateDir !== 'string' || c.stateDir === '') throw new Error('config: stateDir is required');
  const ports = c.network === 'local' ? null : NETWORK_PORTS[c.network];
  // SPEC §5 pins each network's socat and HTTP ports, so a mainnet and a Sepolia host can't be crossed.
  if (ports && c.enclavePort !== undefined && c.enclavePort !== ports.socatPort) throw new Error(`config: enclavePort must be ${ports.socatPort} on ${c.network}`);
  if (ports && c.listen?.port !== undefined && c.listen.port !== ports.sellerPort) throw new Error(`config: listen.port must be ${ports.sellerPort} on ${c.network}`);
  const enclavePort = c.enclavePort ?? ports?.socatPort;
  if (!Number.isSafeInteger(enclavePort)) throw new Error('config: enclavePort is required for local');
  const port = c.listen?.port ?? ports?.sellerPort;
  if (!Number.isSafeInteger(port)) throw new Error('config: listen.port is required for local');
  const fornoUrl = c.fornoUrl ?? (c.network === 'local' ? undefined : FORNO_URL[c.network]);
  if (typeof fornoUrl !== 'string') throw new Error('config: fornoUrl is required for local');
  const host = c.listen?.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('config: seller-host listens on loopback only');
  let buy: BuyConfig | null = null;
  if (c.buy !== undefined) {
    // Paid reads spend real money: mainnet only, and only with the revenue source the budget guard needs.
    if (c.network !== 'mainnet') throw new Error('config: buy reads are mainnet only');
    if (typeof c.gatewayDbPath !== 'string' || c.gatewayDbPath === '') throw new Error('config: buy needs gatewayDbPath');
    const b = c.buy as Record<string, unknown>;
    if (typeof b !== 'object' || b === null) throw new Error('config: buy must be an object');
    if (typeof b.maxAmount !== 'string' || !/^[0-9]+(\.[0-9]{1,6})?$/.test(b.maxAmount)) throw new Error('config: buy.maxAmount must be a decimal USDC string');
    const [whole, frac = ''] = b.maxAmount.split('.');
    for (const k of ['capabilityId', 'url'] as const) if (typeof b[k] !== 'string' || b[k] === '') throw new Error(`config: buy.${k} is required and must be a non-empty string`);
    if (b.keystoreBackend !== undefined && b.keystoreBackend !== 'system' && b.keystoreBackend !== 'file') throw new Error('config: buy.keystoreBackend must be system or file');
    for (const k of ['binary', 'account', 'home'] as const) if (b[k] !== undefined && (typeof b[k] !== 'string' || b[k] === '')) throw new Error(`config: buy.${k} must be a non-empty string`);
    buy = {
      capabilityId: b.capabilityId as string,
      url: b.url as string,
      maxAmountAtomic: BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0')),
      ...(b.binary !== undefined ? { binary: b.binary as string } : {}),
      ...(b.account !== undefined ? { account: b.account as string } : {}),
      ...(b.home !== undefined ? { home: b.home as string } : {}),
      ...(b.keystoreBackend !== undefined ? { keystoreBackend: b.keystoreBackend } : {}),
    };
    validateBuyConfig(buy);
  }
  return {
    buy,
    network: c.network,
    chainId,
    registry: c.registry.toLowerCase(),
    agentId: BigInt(c.agentId),
    origin,
    enclavePort: enclavePort!,
    listen: { host, port: port! },
    fornoUrl,
    gatewayDbPath: c.gatewayDbPath ?? null,
    stateDir: c.stateDir,
  };
}

export function loadConfig(path: string): LoadedConfig {
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}
