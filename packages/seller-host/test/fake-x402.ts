import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyTypedData, type Address } from 'viem';
import { FakeRpc } from './fake-rpc.ts';

/**
 * A local x402 v2 seller, as @celo/buy-core 0.8.5 expects it (dist/x402/v2.js): the challenge is a base64 JSON object in the
 * `payment-required` header, the payment comes back in `PAYMENT-SIGNATURE` (base64 JSON). It checks the EIP-3009 signature
 * and, if good, answers the JSON-RPC body from a FakeRpc. No real network, no real money.
 */
export const USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
export const PAY_TO_SELLER = '0x3333333333333333333333333333333333333333';

export interface Offer {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export class FakeX402 {
  readonly rpc = new FakeRpc();
  offers: Offer[] = [{ scheme: 'exact', network: 'eip155:42220', amount: '10000', asset: USDC, payTo: PAY_TO_SELLER, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } }];
  /** after payment: serve, hang (never answer), 500, garbage (HTML), object (a JSON object, not a batch), redirect. */
  paidMode: 'ok' | 'hang' | 'http500' | 'garbage' | 'object' | 'redirect' = 'ok';
  /** Requests received without a payment header, and payments received (decoded), and payments whose signature verified. */
  unpaid = 0;
  readonly payments: Array<Record<string, any>> = [];
  readonly verified: Address[] = [];
  /** Paid requests whose connection ended while the server held them (a client abort). */
  paidClosed = 0;
  /** Hits on the redirect target. */
  redirectHits = 0;
  private server: Server | null = null;
  url = '';

  async start(): Promise<string> {
    await this.rpc.start();
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/elsewhere') {
        this.redirectHits += 1;
        res.writeHead(200).end('[]');
        return;
      }
      const header = req.headers['payment-signature'];
      if (typeof header !== 'string') {
        this.unpaid += 1;
        const challenge = Buffer.from(JSON.stringify({ x402Version: 2, accepts: this.offers, error: 'payment required' })).toString('base64');
        res.writeHead(402, { 'payment-required': challenge, 'content-type': 'application/json' }).end('{}');
        return;
      }
      const payment = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as Record<string, any>;
      this.payments.push(payment);
      const a = payment.payload.authorization;
      const offer = (payment.accepted ?? this.offers[0]) as Offer;
      const ok = await verifyTypedData({
        address: a.from,
        signature: payment.payload.signature,
        domain: { name: offer.extra.name, version: offer.extra.version, chainId: 42220, verifyingContract: offer.asset as Address },
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
      });
      if (!ok) {
        res.writeHead(402).end('{}');
        return;
      }
      this.verified.push(a.from);
      switch (this.paidMode) {
        case 'hang':
          res.on('close', () => (this.paidClosed += 1));
          return;
        case 'http500':
          res.writeHead(500).end('boom');
          return;
        case 'garbage':
          res.writeHead(200).end('<html>paid</html>');
          return;
        case 'object':
          res.writeHead(200).end(JSON.stringify({ error: 'payment failed' }));
          return;
        case 'redirect':
          res.writeHead(307, { location: `${this.url}/elsewhere` }).end();
          return;
        default: {
          const r = await fetch(this.rpc.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
          res.writeHead(200, { 'content-type': 'application/json' }).end(await r.text());
        }
      }
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  /** A fetch that sends the capability's https URL to this server instead, keeping method, headers, body and signal. */
  readonly fetchImpl: typeof fetch = (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return fetch(`${this.url}${u.pathname}`, init);
  };

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    await this.rpc.stop();
  }
}
