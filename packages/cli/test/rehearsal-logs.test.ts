import { readFileSync } from 'node:fs';
import { DEPLOYMENTS } from '@attessa/core';
import { getContractAddress } from 'viem';
import { expect, it } from 'vitest';
import { getLogsChunked, LOG_WINDOW } from '../src/logs.ts';
import { RpcError, type Rpc } from '../src/rpc.ts';

const DEPLOYER = '0xF31207eE5831fb2a7bFB6f844a4fb16776193964';
const A = getContractAddress({ from: DEPLOYER, nonce: 7n }).toLowerCase();
const CREATION_TX = { hash: '0xc0', to: null, from: DEPLOYER, nonce: '0x7', blockNumber: '0x' + (1_000_000).toString(16) };

/** A node like Forno: rejects a range above 5000 blocks, has the contract from block 1,000,000, head at 1,013,000. */
function forno(): Rpc & { windows: Array<[bigint, bigint]> } {
  const windows: Array<[bigint, bigint]> = [];
  return {
    url: 'http://forno.test',
    windows,
    async request(method, params) {
      if (method === 'eth_blockNumber') return '0x' + (1_013_000).toString(16);
      if (method === 'eth_getCode') return params[1] === 'latest' || BigInt(params[1] as string) >= 1_000_000n ? '0x6080' : '0x';
      if (method === 'eth_getBlockByNumber') return BigInt(params[0] as string) === 1_000_000n ? { transactions: [CREATION_TX] } : { transactions: [] };
      if (method === 'eth_getTransactionByHash') return CREATION_TX;
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

it('no code at head after a range error is an RPC failure, not an empty history (Codex r1 M1: events existed)', async () => {
  const base = forno();
  const rpc: Rpc = { url: 'http://pruned.test', async request(m, p) { return m === 'eth_getCode' ? '0x' : base.request(m, p); } };
  await expect(getLogsChunked(rpc, A, [null])).rejects.toBeInstanceOf(RpcError);
});

it('a failure in a later window is an RPC failure, not a partial history', async () => {
  const base = forno();
  let windows = 0;
  const rpc: Rpc = {
    url: 'http://flaky.test',
    async request(m, p) {
      if (m === 'eth_getLogs' && (p[0] as { toBlock: string }).toBlock !== 'latest' && ++windows === 2) throw new RpcError(-32000, 'boom', undefined);
      return base.request(m, p);
    },
  };
  await expect(getLogsChunked(rpc, A, [null])).rejects.toThrow('boom');
});

it('an old block answered 0x is not taken as the start: no creation transaction there is an RPC failure (Codex r2 M1)', async () => {
  const base = forno();
  // The contract was created at 1,000,000 with an event at 1,005,000, but this node answers 0x below 1,006,000.
  const rpc: Rpc = {
    url: 'http://partial.test',
    async request(m, p) {
      if (m === 'eth_getCode') return BigInt(p[1] as string) >= 1_006_000n ? '0x6080' : '0x';
      return base.request(m, p);
    },
  };
  await expect(getLogsChunked(rpc, A, [null])).rejects.toBeInstanceOf(RpcError);
});

it('another contract in the block, a call rather than a deployment, or no block is not proof', async () => {
  const base = forno();
  const other: Rpc = { url: 'http://other.test', async request(m, p) { return m === 'eth_getBlockByNumber' ? { transactions: [{ ...CREATION_TX, nonce: '0x8' }] } : base.request(m, p); } };
  await expect(getLogsChunked(other, A, [null])).rejects.toBeInstanceOf(RpcError);
  const call: Rpc = { url: 'http://call.test', async request(m, p) { return m === 'eth_getBlockByNumber' ? { transactions: [{ ...CREATION_TX, to: A }] } : base.request(m, p); } };
  await expect(getLogsChunked(call, A, [null])).rejects.toBeInstanceOf(RpcError);
  const noBlock: Rpc = { url: 'http://noblock.test', async request(m, p) { return m === 'eth_getBlockByNumber' ? null : base.request(m, p); } };
  await expect(getLogsChunked(noBlock, A, [null])).rejects.toBeInstanceOf(RpcError);
});

it('two connections to one URL do not share a creation block (Codex r2 M2: a second chain lost its earlier event)', async () => {
  const chain = (created: bigint, event: bigint): Rpc => ({
    url: 'https://rpc.example',
    async request(m, p) {
      if (m === 'eth_blockNumber') return '0x' + (1_013_000).toString(16);
      if (m === 'eth_getCode') return BigInt(p[1] as string) >= created ? '0x6080' : '0x';
      if (m === 'eth_getBlockByNumber') return BigInt(p[0] as string) === created ? { transactions: [CREATION_TX] } : { transactions: [] };
      if (m === 'eth_getLogs') {
        const f = p[0] as { fromBlock: string; toBlock: string };
        if (f.toBlock === 'latest') throw new RpcError(-32602, 'query exceeds range, retry smaller (max block range 5000)', undefined);
        return BigInt(f.fromBlock) <= event && event <= BigInt(f.toBlock) ? [{ topics: ['0x01'], data: '0x', blockNumber: '0x1' }] : [];
      }
      throw new Error(m);
    },
  });
  expect(await getLogsChunked(chain(1_001_000n, 1_002_000n), A, [null])).toHaveLength(1);
  expect(await getLogsChunked(chain(1_000_000n, 1_000_500n), A, [null])).toHaveLength(1);
});

// Forno, read 2026-11-09: eth_getCode and eth_getBlockByNumber more than about 10000 blocks back are refused, an old
// eth_getTransactionReceipt is null, and an old eth_getTransactionByHash is served.
function recentStateOnly(): Rpc & { windows: Array<[bigint, bigint]>; asked: string[] } {
  const base = forno();
  const asked: string[] = [];
  return {
    url: 'http://recent-state-only.test',
    windows: base.windows,
    asked,
    async request(m, p) {
      asked.push(m);
      if (m === 'eth_getTransactionReceipt') return null;
      if (m === 'eth_getBlockByNumber' || (m === 'eth_getCode' && p[1] !== 'latest')) throw new RpcError(-32602, 'block is more than 10064 blocks behind head', undefined);
      return base.request(m, p);
    },
  };
}

it('on a node like Forno, a recorded creation starts the scan there and reads every event', async () => {
  const rpc = recentStateOnly();
  expect(await getLogsChunked(rpc, A, [null], { block: 1_000_000, tx: '0xc0' })).toHaveLength(1);
  expect(rpc.windows[0]![0]).toBe(1_000_000n);
  expect(rpc.windows.at(-1)![1]).toBe(1_013_000n);
});

it('on a node like Forno, with no recorded creation the read fails as an RPC failure, never an empty history', async () => {
  await expect(getLogsChunked(recentStateOnly(), A, [null])).rejects.toBeInstanceOf(RpcError);
});

it.each([
  ['a different sender', { ...CREATION_TX, from: '0x' + '11'.repeat(20) }],
  ['a different nonce', { ...CREATION_TX, nonce: '0x8' }],
  ['a call, not a deployment', { ...CREATION_TX, to: A }],
  ['another block', { ...CREATION_TX, blockNumber: '0xf4241' }],
  ['a pending transaction', { ...CREATION_TX, blockNumber: null }],
  ['no transaction', null],
])('a recorded creation the chain contradicts is an RPC failure: %s', async (_n, tx) => {
  const base = forno();
  const rpc: Rpc = { url: 'http://wrong.test', async request(m, p) { return m === 'eth_getTransactionByHash' ? tx : base.request(m, p); } };
  await expect(getLogsChunked(rpc, A, [null], { block: 1_000_000, tx: '0xc0' })).rejects.toBeInstanceOf(RpcError);
});

it('a recorded creation with no code at head is an RPC failure', async () => {
  const base = forno();
  const rpc: Rpc = { url: 'http://nocode.test', async request(m, p) { return m === 'eth_getCode' ? '0x' : base.request(m, p); } };
  await expect(getLogsChunked(rpc, A, [null], { block: 1_000_000, tx: '0xc0' })).rejects.toBeInstanceOf(RpcError);
});

it('a recorded creation ahead of the head is an RPC failure, not an empty history', async () => {
  const base = forno();
  const ahead = { ...CREATION_TX, blockNumber: '0x' + (2_000_000).toString(16) };
  const rpc: Rpc = { url: 'http://behind.test', async request(m, p) { return m === 'eth_getTransactionByHash' ? ahead : base.request(m, p); } };
  await expect(getLogsChunked(rpc, A, [null], { block: 2_000_000, tx: '0xc0' })).rejects.toBeInstanceOf(RpcError);
});

it('every deployed registry names its creation, and it matches docs/DEPLOYMENTS.md', () => {
  const docs = readFileSync(new URL('../../../docs/DEPLOYMENTS.md', import.meta.url), 'utf8');
  for (const [name, d] of Object.entries(DEPLOYMENTS)) {
    if (!d.enclaveRegistry) { expect(d.enclaveRegistryCreation, name).toBeNull(); continue; }
    expect(d.enclaveRegistryCreation, name).not.toBeNull();
    expect(docs).toContain(`EnclaveRegistry: tx \`${d.enclaveRegistryCreation!.tx}\`, block ${d.enclaveRegistryCreation!.block},`);
  }
});
