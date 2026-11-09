import { expect, it } from 'vitest';
import { getLogsChunked } from '../src/logs.ts';
import { RpcError, type Rpc } from '../src/rpc.ts';

const DEPLOYER = '0xF31207eE5831fb2a7bFB6f844a4fb16776193964';
const A = '0x6e87c65d7440901445acfbc6c0e1f8be328a82b9';

it.each([['null', null], ['an object', {}], ['a string', '0x'], ['undefined', undefined]])('whole-range eth_getLogs answering %s is an RPC failure, not a result', async (_n, bad) => {
  const rpc: Rpc = { url: 'x', async request() { return bad as never; } };
  await expect(getLogsChunked(rpc, A, [null])).rejects.toBeInstanceOf(Error);
});

it('a window answering a string is not spread into one-character logs', async () => {
  const rpc: Rpc = {
    url: 'x',
    async request(m, p) {
      if (m === 'eth_blockNumber') return '0x10';
      if (m === 'eth_getLogs') {
        if ((p[0] as { toBlock: string }).toBlock === 'latest') throw new RpcError(-32602, 'query exceeds range', undefined);
        return 'abc';
      }
      if (m === 'eth_getTransactionByHash') return { to: null, from: DEPLOYER, nonce: '0x7', blockNumber: '0x1' };
      if (m === 'eth_getCode') return '0x6080';
      throw new Error(m);
    },
  };
  const out = await getLogsChunked(rpc, A, [null], { block: 1, tx: '0xc0' }).catch(() => 'rejected');
  expect(out).toBe('rejected');
});
