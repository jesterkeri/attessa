import {
  createPublicClient,
  decodeEventLog,
  encodeEventTopics,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

export interface BlockHeader {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

export interface AccountState {
  code: Hex;
  nonce: bigint;
  balance: bigint;
}

export interface ChainLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: bigint;
}

export interface Receipt {
  transactionHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: ChainLog[];
}

/** IEnclaveRegistry.Check (SPEC §3.1). */
export const CHECK = [
  'OK',
  'UNKNOWN_SIGNER',
  'SIGNER_REVOKED',
  'SIGNER_EXPIRED',
  'RELEASE_NOT_APPROVED',
  'ENDPOINT_INACTIVE',
  'ENDPOINT_MISMATCH',
  'AGENT_MISMATCH',
  'OPERATOR_MISMATCH',
  'BAD_SIGNATURE',
  'PROOF_EXPIRED',
  'PROOF_CLOCK_SKEW',
] as const;
export type CheckName = (typeof CHECK)[number];

export interface SignerCheck {
  code: CheckName;
  agentId: bigint;
  releaseId: Hex;
}

/**
 * Everything the gateway reads from Celo. Every method throws on an RPC failure; callers decide what an
 * unanswered read means (it never proves an authorization unused, SPEC §6.2 step 11).
 */
export interface Chain {
  blockNumber(): Promise<bigint>;
  latestBlock(): Promise<BlockHeader>;
  /** null when the node has no such block. */
  blockByNumber(n: bigint): Promise<BlockHeader | null>;
  accountAt(address: Address, block: bigint): Promise<AccountState>;
  checkSigner(registry: Address, signer: Address, originHash: Hex): Promise<SignerCheck>;
  /** Raw logs of `event` from `asset` with the given indexed topics, from `fromBlock` to latest. */
  getLogs(asset: Address, topics: Hex[], fromBlock: bigint): Promise<ChainLog[]>;
  /** null when the node doesn't know the transaction (yet). */
  receipt(tx: Hex): Promise<Receipt | null>;
  authorizationState(asset: Address, authorizer: Address, nonce: Hex, block: bigint): Promise<boolean>;
}

export const TOKEN_EVENTS = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

const TOKEN_READS = parseAbi(['function authorizationState(address authorizer, bytes32 nonce) view returns (bool)']);

export const REGISTRY_ABI = parseAbi([
  'struct Signer { uint256 agentId; bytes32 releaseId; bytes32 originHash; address operator; uint64 registeredAt; uint64 expiresAt; uint8 status; bytes32 attestationHash; }',
  'struct Endpoint { uint256 agentId; address payTo; address operator; uint8 status; uint64 updatedAt; }',
  'function checkSigner(address signer, bytes32 originHash) view returns (uint8 code, Signer s, Endpoint e)',
]);

export function authorizationTopics(event: 'AuthorizationUsed' | 'AuthorizationCanceled', authorizer: Address, nonce: Hex): Hex[] {
  return encodeEventTopics({ abi: TOKEN_EVENTS, eventName: event, args: { authorizer, nonce } }) as Hex[];
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export interface Settlement {
  asset: Address;
  payer: Address;
  payTo: Address;
  amount: bigint;
  nonce: Hex;
}

/** True when `log` is `AuthorizationUsed(payer, nonce)` emitted by `asset`. */
export function isAuthorizationUsed(log: ChainLog, s: Pick<Settlement, 'asset' | 'payer' | 'nonce'>): boolean {
  if (!sameAddress(log.address, s.asset)) return false;
  try {
    const ev = decodeEventLog({ abi: TOKEN_EVENTS, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return (
      ev.eventName === 'AuthorizationUsed' &&
      sameAddress(ev.args.authorizer, s.payer) &&
      ev.args.nonce.toLowerCase() === s.nonce.toLowerCase()
    );
  } catch {
    return false;
  }
}

/** True when `log` is `Transfer(payer → payTo, amount)` emitted by `asset`. */
export function isSettlementTransfer(log: ChainLog, s: Settlement): boolean {
  if (!sameAddress(log.address, s.asset)) return false;
  try {
    const ev = decodeEventLog({ abi: TOKEN_EVENTS, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return (
      ev.eventName === 'Transfer' &&
      sameAddress(ev.args.from, s.payer) &&
      sameAddress(ev.args.to, s.payTo) &&
      ev.args.value === s.amount
    );
  } catch {
    return false;
  }
}

/**
 * SPEC §6.2 step 11 / §6.3 / INV-11: a receipt settles a call only if it succeeded and, from the quoted
 * asset, carries both `AuthorizationUsed(payer, nonce)` and `Transfer(payer → payTo, amount)`.
 */
export function receiptSettles(r: Receipt, s: Settlement): boolean {
  return (
    r.status === 'success' &&
    r.logs.some((l) => isAuthorizationUsed(l, s)) &&
    r.logs.some((l) => isSettlementTransfer(l, s))
  );
}

/** viem-backed Chain over one JSON-RPC URL. */
export class RpcChain implements Chain {
  private readonly client: PublicClient;

  constructor(rpcUrl: string, timeoutMs = 10_000) {
    this.client = createPublicClient({ transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 1 }) });
  }

  blockNumber(): Promise<bigint> {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  async latestBlock(): Promise<BlockHeader> {
    const b = await this.client.getBlock({ blockTag: 'latest' });
    return { number: b.number, hash: b.hash, timestamp: b.timestamp };
  }

  async blockByNumber(n: bigint): Promise<BlockHeader | null> {
    try {
      const b = await this.client.getBlock({ blockNumber: n });
      return { number: b.number, hash: b.hash, timestamp: b.timestamp };
    } catch (e) {
      if ((e as { name?: string }).name === 'BlockNotFoundError') return null;
      throw e;
    }
  }

  async accountAt(address: Address, block: bigint): Promise<AccountState> {
    const [code, nonce, balance] = await Promise.all([
      this.client.getCode({ address, blockNumber: block }),
      this.client.getTransactionCount({ address, blockNumber: block }),
      this.client.getBalance({ address, blockNumber: block }),
    ]);
    return { code: (code ?? '0x').toLowerCase() as Hex, nonce: BigInt(nonce), balance };
  }

  async checkSigner(registry: Address, signer: Address, originHash: Hex): Promise<SignerCheck> {
    const [code, s] = await this.client.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'checkSigner',
      args: [signer, originHash],
    });
    const name = CHECK[code];
    if (!name) throw new Error(`checkSigner: unknown code ${code}`);
    return { code: name, agentId: s.agentId, releaseId: s.releaseId };
  }

  async getLogs(asset: Address, topics: Hex[], fromBlock: bigint): Promise<ChainLog[]> {
    const logs = await this.client.request({
      method: 'eth_getLogs',
      params: [{ address: asset, topics, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: 'latest' }],
    });
    return logs.map((l) => ({
      address: l.address,
      topics: l.topics as Hex[],
      data: l.data,
      transactionHash: l.transactionHash as Hex,
      blockNumber: BigInt(l.blockNumber as Hex),
    }));
  }

  async receipt(tx: Hex): Promise<Receipt | null> {
    try {
      const r = await this.client.getTransactionReceipt({ hash: tx });
      return {
        transactionHash: r.transactionHash,
        status: r.status,
        blockNumber: r.blockNumber,
        logs: r.logs.map((l) => ({
          address: l.address,
          topics: l.topics as Hex[],
          data: l.data,
          transactionHash: l.transactionHash,
          blockNumber: l.blockNumber,
        })),
      };
    } catch (e) {
      if ((e as { name?: string }).name === 'TransactionReceiptNotFoundError') return null;
      throw e;
    }
  }

  authorizationState(asset: Address, authorizer: Address, nonce: Hex, block: bigint): Promise<boolean> {
    return this.client.readContract({
      address: asset,
      abi: TOKEN_READS,
      functionName: 'authorizationState',
      args: [authorizer, nonce],
      blockNumber: block,
    });
  }
}
