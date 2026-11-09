import type { Hex } from 'viem';
import type { Rpc } from './rpc.ts';

/** Forno rejects an eth_getLogs range above 5000 blocks ("query exceeds range, retry smaller (max block range 5000)"). */
export const LOG_WINDOW = 4000n;

const creationCache = new Map<string, bigint>();

/** The block a contract's code first appears at, found by binary search on eth_getCode (needs historical state). */
export async function creationBlock(rpc: Rpc, address: string, head: bigint): Promise<bigint> {
  const key = `${rpc.url}|${address.toLowerCase()}`;
  const hit = creationCache.get(key);
  if (hit !== undefined) return hit;
  const hasCode = async (b: bigint) => {
    const code = (await rpc.request('eth_getCode', [address, `0x${b.toString(16)}`])) as string;
    return code !== '0x' && code !== '0x0';
  };
  let lo = 0n;
  let hi = head;
  if (!(await hasCode(hi))) return hi; // no code yet: nothing to scan before head
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await hasCode(mid)) hi = mid;
    else lo = mid + 1n;
  }
  creationCache.set(key, lo);
  return lo;
}

/** eth_getLogs for one contract over its whole life, in windows a public RPC accepts, from the block it was created in. */
export async function getLogsChunked(rpc: Rpc, address: string, topics: Array<Hex | null>): Promise<Array<{ topics: Hex[]; data: Hex; blockNumber?: string }>> {
  // The whole range in one call first: a local node or a small chain answers it. A public RPC that caps the range
  // (Forno: 5000 blocks) rejects it, and only then does the windowed scan below run.
  try {
    return (await rpc.request('eth_getLogs', [{ address, topics, fromBlock: '0x0', toBlock: 'latest' }])) as Array<{ topics: Hex[]; data: Hex; blockNumber?: string }>;
  } catch (e) {
    if (!/range|limit|exceed|too (many|large|big)|10000|5000/i.test((e as Error).message ?? '')) throw e;
  }
  const head = BigInt((await rpc.request('eth_blockNumber', [])) as string);
  const from = await creationBlock(rpc, address, head);
  const out: Array<{ topics: Hex[]; data: Hex; blockNumber?: string }> = [];
  for (let start = from; start <= head; start += LOG_WINDOW) {
    const end = start + LOG_WINDOW - 1n < head ? start + LOG_WINDOW - 1n : head;
    const part = (await rpc.request('eth_getLogs', [{ address, topics, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }])) as typeof out;
    out.push(...part);
  }
  return out;
}
