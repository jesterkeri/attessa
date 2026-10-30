import { DEPLOYMENTS } from '@attessa/core';
import type { EnclaveTransport } from '@attessa/seller-host';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { ERR } from './copy.ts';
import { HttpRpc, RpcUnavailable, type Rpc } from './rpc.ts';

/** Everything a command touches outside the process, so tests swap each one for a fake. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Shows `[yes/cancel]`-style prompts; true only on the yes word. */
  confirm(yesWord: string): Promise<boolean>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  run(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<RunResult>;
}

export interface Deps {
  io: Io;
  env: Record<string, string | undefined>;
  cwd: string;
  rpc(url: string): Rpc;
  runner: Runner;
  fetch: typeof fetch;
  /** The enclave's framed protocol at 127.0.0.1:<port> (socat). */
  enclave(port: number): EnclaveTransport;
  readFile(path: string): Buffer;
  writeFile(path: string, data: Uint8Array | string): void;
  exists(path: string): boolean;
  readdir(path: string): string[];
  sleep(ms: number): Promise<void>;
  arch: string;
}

export type NetworkFlag = 'sepolia' | 'mainnet' | 'local';

export interface Global {
  network: NetworkFlag;
  rpc?: string | undefined;
  json: boolean;
  yes: boolean;
  dryRun: boolean;
}

export const DEFAULT_RPC: Record<Exclude<NetworkFlag, 'local'>, string> = {
  sepolia: 'https://forno.celo-sepolia.celo-testnet.org',
  mainnet: 'https://forno.celo.org',
};

/** seller-host HTTP per network (SPEC §5). */
export const SELLER_HOST_URL: Record<Exclude<NetworkFlag, 'local'>, string> = {
  mainnet: 'http://127.0.0.1:7070',
  sepolia: 'http://127.0.0.1:7071',
};

export interface Chain {
  network: NetworkFlag;
  chainId: number;
  rpc: Rpc;
  registry: Address;
  /** The signing account, only from env `ATTESSA_PRIVATE_KEY`. Null means: plan and simulate, never send. */
  account: PrivateKeyAccount | null;
}

const KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The key never leaves this function except as a viem account; it is never printed. */
export function loadAccount(env: Deps['env']): PrivateKeyAccount | null {
  const k = env.ATTESSA_PRIVATE_KEY;
  if (k === undefined || k === '') return null;
  if (!KEY.test(k)) throw ERR.usage('ATTESSA_PRIVATE_KEY must be 0x followed by 64 hex characters.');
  return privateKeyToAccount(k as Hex);
}

/** Resolves network, RPC and registry, and checks the RPC's chain id (FLOWS §7 wrong network). */
export async function connect(g: Global, deps: Deps): Promise<Chain> {
  const url = g.rpc ?? (g.network === 'local' ? undefined : DEFAULT_RPC[g.network]);
  if (!url) throw ERR.usage('--network local needs --rpc.');
  const rpc = deps.rpc(url);
  let reported: number;
  try {
    reported = Number(BigInt((await rpc.request('eth_chainId', [])) as string));
  } catch (e) {
    if (e instanceof RpcUnavailable) throw ERR.rpcUnavailable(url);
    throw e;
  }
  let chainId: number;
  let deployed: Address | null = null;
  if (g.network === 'local') {
    // SPEC §2.6: the deployments entry and pins come from the network whose chain id the RPC reports.
    chainId = reported;
    deployed = Object.values(DEPLOYMENTS).find((d) => d.chainId === reported)?.enclaveRegistry ?? null;
  } else {
    const d = DEPLOYMENTS[g.network === 'mainnet' ? 'celo' : 'celo-sepolia'];
    chainId = d.chainId;
    deployed = d.enclaveRegistry;
    if (reported !== chainId) throw ERR.networkMismatch(reported, chainId);
  }
  // A deployed registry is authoritative; ATTESSA_REGISTRY only fills in before deploy, or on a chain with no pins.
  const registry = deployed ?? deps.env.ATTESSA_REGISTRY ?? null;
  if (!registry) throw ERR.noRegistry(g.network);
  if (!ADDRESS.test(registry)) throw ERR.usage('ATTESSA_REGISTRY must be an address.');
  return { network: g.network, chainId, rpc, registry: registry.toLowerCase() as Address, account: loadAccount(deps.env) };
}
