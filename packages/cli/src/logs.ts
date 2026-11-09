import { getContractAddress, type Hex } from 'viem';
import { RpcError, type Rpc } from './rpc.ts';

/** Forno rejects an eth_getLogs range above 5000 blocks ("query exceeds range, retry smaller (max block range 5000)"). */
export const LOG_WINDOW = 4000n;

// Per connection: one URL can front different chains or forks, and a boundary from one says nothing about another.
const creationCache = new WeakMap<Rpc, Map<string, bigint>>();

interface CreationTx {
  to?: string | null;
  from?: string;
  nonce?: string;
  blockNumber?: string;
}

/** True if this transaction deploys directly to this address: no `to`, and its sender and nonce derive the address. */
function creates(tx: CreationTx | null | undefined, address: string): boolean {
  if (!tx || tx.to || !tx.from || tx.nonce === undefined) return false;
  return getContractAddress({ from: tx.from as Hex, nonce: BigInt(tx.nonce) }).toLowerCase() === address.toLowerCase();
}

/** True if a transaction in this block created this contract directly. */
async function createdIn(rpc: Rpc, address: string, block: bigint): Promise<boolean> {
  const b = (await rpc.request('eth_getBlockByNumber', [`0x${block.toString(16)}`, true])) as { transactions?: CreationTx[] } | null;
  return (b?.transactions ?? []).some((tx) => creates(tx, address));
}

/**
 * For a contract with no recorded creation: the block it was created in, found by binary search on eth_getCode and then
 * proved by its creation transaction.
 * A node's `0x` for an old block can mean it doesn't hold that state, not that the contract wasn't there, so the search
 * alone proves nothing: starting from an unproved block would drop real events. No proof is an RPC failure, never a guess.
 */
export async function creationBlock(rpc: Rpc, address: string, head: bigint): Promise<bigint> {
  const key = address.toLowerCase();
  const hit = creationCache.get(rpc)?.get(key);
  if (hit !== undefined) return hit;
  const hasCode = async (b: bigint) => {
    const code = (await rpc.request('eth_getCode', [address, `0x${b.toString(16)}`])) as string;
    return code !== '0x' && code !== '0x0';
  };
  let lo = 0n;
  let hi = head;
  // No code at head doesn't prove there are no events: it can be a pruned or inconsistent node, or the wrong address.
  // This runs only after a range error, so report an RPC failure, never an empty history.
  if (!(await hasCode(hi))) throw new RpcError(-32000, `no contract code at ${address} at block ${head}, so its events can't be read`, undefined);
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await hasCode(mid)) hi = mid;
    else lo = mid + 1n;
  }
  if (!(await createdIn(rpc, address, lo))) throw new RpcError(-32000, `no transaction in block ${lo} created ${address}, so where its events start isn't proved`, undefined);
  const known = creationCache.get(rpc) ?? new Map<string, bigint>();
  known.set(key, lo);
  creationCache.set(rpc, known);
  return lo;
}

export interface Creation {
  block: number;
  tx: string;
}

/**
 * The recorded creation, checked against the chain. Forno serves an old transaction by hash but no old receipt, block or
 * state, so the proof is the transaction itself (its sender and nonce derive this address, in that block) plus code at head.
 */
async function provenCreation(rpc: Rpc, address: string, creation: Creation): Promise<bigint> {
  const block = BigInt(creation.block);
  const tx = (await rpc.request('eth_getTransactionByHash', [creation.tx])) as CreationTx | null;
  const code = (await rpc.request('eth_getCode', [address, 'latest'])) as string;
  if (!creates(tx, address) || tx?.blockNumber === undefined || tx.blockNumber === null || BigInt(tx.blockNumber) !== block || code === '0x' || code === '0x0') {
    throw new RpcError(-32000, `this RPC doesn't show ${creation.tx} creating ${address} in block ${block}, so where its events start isn't proved`, undefined);
  }
  return block;
}

/** eth_getLogs for one contract over its whole life, in windows a public RPC accepts, from the block it was created in. */
export async function getLogsChunked(rpc: Rpc, address: string, topics: Array<Hex | null>, creation?: Creation | null): Promise<Array<{ topics: Hex[]; data: Hex; blockNumber?: string }>> {
  // The whole range in one call first: a local node or a small chain answers it. A public RPC that caps the range
  // (Forno: 5000 blocks) rejects it, and only then does the windowed scan below run.
  try {
    return (await rpc.request('eth_getLogs', [{ address, topics, fromBlock: '0x0', toBlock: 'latest' }])) as Array<{ topics: Hex[]; data: Hex; blockNumber?: string }>;
  } catch (e) {
    if (!/range|limit|exceed|too (many|large|big)|10000|5000/i.test((e as Error).message ?? '')) throw e;
  }
  const head = BigInt((await rpc.request('eth_blockNumber', [])) as string);
  // Forno refuses eth_getCode and eth_getBlockByNumber more than about 10000 blocks behind head, so a recorded creation is the
  // only start that works there. Without one, the search needs a node that serves old state, and fails safe otherwise.
  const from = creation ? await provenCreation(rpc, address, creation) : await creationBlock(rpc, address, head);
  if (from > head) throw new RpcError(-32000, `this RPC's head ${head} is behind the block ${from} that created ${address}`, undefined);
  const out: Array<{ topics: Hex[]; data: Hex; blockNumber?: string }> = [];
  for (let start = from; start <= head; start += LOG_WINDOW) {
    const end = start + LOG_WINDOW - 1n < head ? start + LOG_WINDOW - 1n : head;
    const part = (await rpc.request('eth_getLogs', [{ address, topics, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }])) as typeof out;
    out.push(...part);
  }
  return out;
}
