import { expect, it } from 'vitest';
import { getLogsChunked, LOG_WINDOW } from '../src/logs.ts';
import { RpcError, type Rpc } from '../src/rpc.ts';

const A = '0x6a967524839003e16afd9a9a8c89d3ddcf0b7006';

/** A node like Forno: rejects a range above 5000 blocks, has the contract from block 1,000,000, head at 1,013,000. */
function forno(): Rpc & { windows: Array<[bigint, bigint]> } {
  const windows: Array<[bigint, bigint]> = [];
  return {
    url: 'http://forno.test',
    windows,
    async request(method, params) {
      if (method === 'eth_blockNumber') return '0x' + (1_013_000).toString(16);
      if (method === 'eth_getCode') return BigInt(params[1] as string) >= 1_000_000n ? '0x6080' : '0x';
      if (method === 'eth_getLogs') {
        const f = params[0] as { fromBlock: string; toBlock: string };
        const from = BigInt(f.fromBlock);
        const to = f.toBlock === 'latest' ? 1_013_000n : BigInt(f.toBlock);
        if (to - from + 1n > 5000n) throw new RpcError(-32602, `query exceeds range, retry smaller (max block range 5000, got ${to - from + 1n})`, undefined);
        windows.push([from, to]);
        return from <= 1_005_000n && 1_005_000n <= to ? [{ topics: ['0x01'], data: '0x', blockNumber: '0xf4a38' }] : [];
      }
      throw new Error(method);
    },
  };
}

it('scans a registry on an RPC that caps eth_getLogs at 5000 blocks (status and signer register read from block 0 and failed on Forno)', async () => {
  const rpc = forno();
  const logs = await getLogsChunked(rpc, A, [null]);
  expect(logs).toHaveLength(1);
  expect(rpc.windows[0]![0]).toBe(1_000_000n); // started at the creation block, not 0
  expect(rpc.windows.every(([a, b]) => b - a + 1n <= LOG_WINDOW)).toBe(true);
  expect(rpc.windows.at(-1)![1]).toBe(1_013_000n);
});

it('a node without a cap still answers in one call', async () => {
  const calls: string[] = [];
  const rpc: Rpc = { url: 'x', async request(m) { calls.push(m); return []; } };
  expect(await getLogsChunked(rpc, A, [null])).toEqual([]);
  expect(calls).toEqual(['eth_getLogs']);
});

it('another RPC error is not swallowed', async () => {
  const rpc: Rpc = { url: 'x', async request() { throw new RpcError(-32000, 'boom', undefined); } };
  await expect(getLogsChunked(rpc, A, [null])).rejects.toThrow('boom');
});

it('no environment variable can move the scan past the events (adversary: a stale start block returned "no events")', async () => {
  process.env.ATTESSA_REGISTRY_FROM_BLOCK = '99999999999';
  try {
    expect(await getLogsChunked(forno(), A, [null])).toHaveLength(1);
  } finally {
    delete process.env.ATTESSA_REGISTRY_FROM_BLOCK;
  }
});
