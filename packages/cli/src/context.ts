import { DEPLOYMENTS } from '@attessa/core';
import { KeyError, keyToAccount, type ClientOptions, type Keychain } from '@attessa/sdk';
import type { EnclaveTransport } from '@attessa/seller-host';
import type { Address } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { CliError, ERR } from './copy.ts';
import { HttpRpc, type Rpc } from './rpc.ts';
import { rpcRow } from './tx.ts';

/** Everything a command touches outside the process, so tests swap each one for a fake. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Shows `[yes/cancel]`-style prompts; true only on the yes word. */
  confirm(yesWord: string): Promise<boolean>;
  /** Machine-readable result fields for `--json` (merged into the one JSON object `run` prints). */
  data?(fields: Record<string, unknown>): void;
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
  /** Host socat port per enclave, SPEC §5 (5005 / 5007 / 5006) when absent. A test seam only. */
  socatPorts?: Record<'mainnet' | 'sepolia' | 'test', number> | undefined;
  /** The buyer's home; data lives in `<home>/.attessa` unless ATTESSA_DATA_DIR is set. Defaults to the OS home. */
  home?: string | undefined;
  /** OS keychain for the buyer key (SPEC §7 key storage). Absent: keytar if it loads. A test seam. */
  keychain?: Keychain | null | undefined;
  /** SDK client options (transport, fetch, clock). Absent in production. A test seam. */
  sdk?: Pick<ClientOptions, 'transport' | 'fetch' | 'sleep' | 'now' | 'receiptWaitMs' | 'httpTimeoutMs'> | undefined;
  /** `attessa gateway …`: @attessa/gateway's runGatewayCommand, loaded only when used. */
  gateway?: ((args: string[], out: (s: string) => void, err: (s: string) => void) => Promise<number>) | undefined;
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
  /** The RPC as the user set it (`--rpc`) or the network's default: the one copy names (FLOWS §8 "Can't reach Celo at {rpc}"). */
  url: string;
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
  try {
    return keyToAccount(k, 'env');
  } catch (e) {
    // viem's own message for zero or a key above the curve order quotes the key in decimal (SPEC §7 "Never
    // printed"): only the SDK's fixed reason gets out, worded as the buyer commands word it. // not in FLOWS
    throw new CliError('bad_key', `Can't load the wallet from ATTESSA_PRIVATE_KEY: ${e instanceof KeyError ? e.reason : 'not a valid private key'}.`);
  }
}

/**
 * Resolves network, RPC and registry, and checks the RPC's chain id (FLOWS §7 wrong network). A read-only command
 * passes `{ wallet: false }`: FLOWS "Reading doesn't require a wallet", so it never loads ATTESSA_PRIVATE_KEY and a
 * malformed one can't block it.
 */
export async function connect(g: Global, deps: Deps, o: { wallet?: boolean } = {}): Promise<Chain> {
  const url = g.rpc ?? (g.network === 'local' ? undefined : DEFAULT_RPC[g.network]);
  if (!url) throw ERR.usage('--network local needs --rpc.');
  const rpc = deps.rpc(url);
  let reported: number;
  try {
    reported = Number(BigInt((await rpc.request('eth_chainId', [])) as string));
  } catch (e) {
    throw rpcRow(url, e);
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
  return { network: g.network, chainId, rpc, url, registry: registry.toLowerCase() as Address, account: o.wallet === false ? null : loadAccount(deps.env) };
}
