import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { keccak256, toHex } from 'viem';

/** A JSON-RPC node over HTTP with a short fake chain, for input-fetch tests. No real network. */

export interface FakeAccount {
  code: string;
  nonce: bigint;
  balance: bigint;
}

export class FakeRpc {
  head = 1000n;
  accounts = new Map<string, FakeAccount>();
  /** Every JSON-RPC request body received (arrays for batches). */
  readonly requests: unknown[] = [];
  mode: 'ok' | 'http500' | 'hang' | 'rpc_error' | 'wrong_block' = 'ok';
  private server: Server | null = null;
  url = '';

  blockHash(n: bigint): string {
    return keccak256(toHex(`block-${n}`));
  }
  blockTimestamp(n: bigint): bigint {
    return 1_700_000_000n + n;
  }

  private answer(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'eth_blockNumber':
        return toHex(this.head);
      case 'eth_getBlockByNumber': {
        const n = BigInt(params[0] as string);
        const reported = this.mode === 'wrong_block' ? n + 1n : n;
        return { number: toHex(reported), hash: this.blockHash(reported), timestamp: toHex(this.blockTimestamp(reported)) };
      }
      case 'eth_getCode':
        return this.accounts.get(params[0] as string)?.code ?? '0x';
      case 'eth_getTransactionCount':
        return toHex(this.accounts.get(params[0] as string)?.nonce ?? 0n);
      case 'eth_getBalance':
        return toHex(this.accounts.get(params[0] as string)?.balance ?? 0n);
      default:
        throw new Error(`unsupported ${method}`);
    }
  }

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      this.requests.push(body);
      if (this.mode === 'hang') return; // never answers
      if (this.mode === 'http500') {
        res.writeHead(500).end('boom');
        return;
      }
      const one = (r: { id: unknown; method: string; params: unknown[] }) => {
        if (this.mode === 'rpc_error') return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'nope' } };
        return { jsonrpc: '2.0', id: r.id, result: this.answer(r.method, r.params) };
      };
      // Reply in reverse order: a batch reply may come in any order.
      const out = Array.isArray(body) ? body.map(one).reverse() : one(body as any);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
