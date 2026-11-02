import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payerSigMessage } from '@attessa/core';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { parseConfig, type GatewayConfig, type GatewayConfigFile } from '../../src/config.ts';
import { CallStore, type CallRow } from '../../src/db.ts';
import { HttpFacilitator, type Facilitator } from '../../src/facilitator.ts';
import { createGateway, type Gateway } from '../../src/gateway.ts';
import { Clock, FakeChain } from './chain.ts';
import { FakeFacilitator } from './facilitator.ts';
import { FakeSellerHost } from './sellerhost.ts';

const randAddr = (): Address => `0x${randomBytes(20).toString('hex')}` as Address;
export const randNonce = (): Hex => `0x${randomBytes(32).toString('hex')}` as Hex;
export const randRequestId = randNonce;

export interface PaymentOptions {
  /** Index into the 402 `accepts[]`. */
  offer?: number;
  validBefore?: number;
  validAfter?: number;
  nonce?: Hex;
  value?: string;
  to?: Address;
  key?: Hex;
  accepted?: (a: Record<string, any>) => Record<string, any>;
  payload?: (p: Record<string, any>) => Record<string, any>;
}

export interface Payment {
  header: string;
  nonce: Hex;
  from: Address;
  accepted: Record<string, any>;
  validBefore: number;
}

export interface Harness {
  cfg: GatewayConfig;
  clock: Clock;
  chain: FakeChain;
  fac: FakeFacilitator;
  seller: FakeSellerHost;
  db: CallStore;
  gw: Gateway;
  buyerKey: Hex;
  buyer: Address;
  body: string;
  logs: Array<{ event: string } & Record<string, unknown>>;
  quote(headers?: Record<string, string>): Promise<import('fastify').LightMyRequestResponse>;
  offers(): Promise<Array<Record<string, any>>>;
  pay(o?: PaymentOptions): Promise<Payment>;
  call(p: Payment | string, o?: { requestId?: string; body?: string; url?: string }): Promise<import('fastify').LightMyRequestResponse>;
  results(requestId: string, o?: { key?: Hex; at?: number }): Promise<import('fastify').LightMyRequestResponse>;
  row(requestId: string): CallRow | undefined;
  rows(): CallRow[];
  /** A second gateway process on the same database (a restart). */
  restart(): Promise<Gateway>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  network?: 'celo-sepolia' | 'celo';
  config?: Partial<GatewayConfigFile>;
  /** Wraps the gateway's facilitator client (to simulate a crash at a precise point). */
  wrapFacilitator?: (f: Facilitator) => Facilitator;
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const network = opts.network ?? 'celo-sepolia';
  const clock = new Clock();
  const chain = new FakeChain(clock);
  const chainId = network === 'celo' ? 42220 : 11142220;
  const fac = new FakeFacilitator(chain, clock, chainId);
  await fac.start();
  const dir = mkdtempSync(join(tmpdir(), 'attessa-gw-'));
  const raw: GatewayConfigFile = {
    network,
    registry: randAddr(),
    agentId: '7',
    origin: 'https://risk.example',
    payTo: randAddr(),
    prices: network === 'celo' ? { usdc: '20000', usat: '20000' } : { usdc: '20000' },
    sellerHostUrl: 'http://127.0.0.1:1',
    facilitatorUrl: fac.url,
    dbPath: join(dir, 'gw.sqlite'),
    timeouts: {
      executeMs: 400,
      settleMs: 400,
      receiptPollMs: 300,
      receiptPollIntervalMs: 20,
      maxRetryAfterMs: 1000,
      verifyMs: 2000,
      signerRefreshMs: 60_000,
    },
    ...opts.config,
  };
  const cfg = parseConfig(raw);
  const db = new CallStore(cfg.dbPath);
  const seller = new FakeSellerHost(cfg, chain, clock);
  chain.signers.set(seller.signer, { code: 'OK', agentId: cfg.agentId, releaseId: seller.releaseId });
  const target = randAddr();
  chain.setAccount(target, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  const buyerKey = generatePrivateKey();
  const buyer = privateKeyToAccount(buyerKey).address.toLowerCase() as Address;
  for (const a of cfg.assets) chain.fund(a.pin.address, buyer, 10_000_000n);
  const logs: Harness['logs'] = [];
  const log = (event: string, fields: Record<string, unknown>) => logs.push({ event, ...fields });
  const mk = () =>
    createGateway({
      cfg,
      db,
      chain,
      facilitator: (opts.wrapFacilitator ?? ((f: Facilitator) => f))(new HttpFacilitator(cfg.facilitatorUrl, undefined)),
      sellerHost: seller,
      now: clock.now,
      log,
    });
  let gw = mk();
  await gw.app.ready();
  const body = JSON.stringify({ chainId: String(chainId), payTo: target, asset: cfg.assets[0]!.pin.address, amount: '20000' });

  const h: Harness = {
    cfg,
    clock,
    chain,
    fac,
    seller,
    db,
    get gw() {
      return gw;
    },
    buyerKey,
    buyer,
    body,
    logs,
    quote(headers = {}) {
      return gw.app.inject({ method: 'POST', url: '/v1/evaluate', headers: { 'content-type': 'application/json', ...headers }, payload: body });
    },
    async offers() {
      const r = await h.quote();
      return JSON.parse(Buffer.from(r.headers['payment-required'] as string, 'base64').toString('utf8')).accepts;
    },
    async pay(o = {}) {
      const offers = await h.offers();
      let accepted = offers[o.offer ?? 0] as Record<string, any>;
      if (o.accepted) accepted = o.accepted(structuredClone(accepted));
      const key = o.key ?? buyerKey;
      const account = privateKeyToAccount(key);
      const nonce = o.nonce ?? randNonce();
      const validBefore = o.validBefore ?? clock.t + 120;
      const auth = {
        from: account.address,
        to: (o.to ?? accepted.payTo) as Address,
        value: o.value ?? (accepted.amount as string),
        validAfter: String(o.validAfter ?? clock.t - 1),
        validBefore: String(validBefore),
        nonce,
      };
      const signature = await account.signTypedData({
        domain: { name: accepted.extra.name, version: accepted.extra.version, chainId, verifyingContract: accepted.asset },
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
        message: { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) },
      });
      let payload: Record<string, any> = {
        x402Version: 2,
        resource: { url: `${cfg.origin}/v1/evaluate`, description: 'x', mimeType: 'application/json' },
        accepted,
        payload: { signature, authorization: auth },
      };
      if (o.payload) payload = o.payload(payload);
      return {
        header: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
        nonce,
        from: account.address.toLowerCase() as Address,
        accepted,
        validBefore,
      };
    },
    call(p, o = {}) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'payment-signature': typeof p === 'string' ? p : p.header,
      };
      if (o.requestId) headers['x-request-id'] = o.requestId;
      return gw.app.inject({ method: 'POST', url: o.url ?? '/v1/evaluate', headers, payload: o.body ?? body });
    },
    async results(requestId, o = {}) {
      const at = o.at ?? clock.t;
      const signature = await privateKeyToAccount(o.key ?? buyerKey).signMessage({ message: payerSigMessage(requestId as Hex, at) });
      return gw.app.inject({ method: 'GET', url: `/v1/results/${requestId}`, headers: { 'x-attest-payer-sig': `${at}.${signature}` } });
    },
    row: (id) => db.byRequestId(id),
    rows: () => db.db.prepare('SELECT * FROM calls').all() as CallRow[],
    async restart() {
      await gw.close();
      gw = mk();
      await gw.app.ready();
      return gw;
    },
    async close() {
      await gw.close();
      db.close();
      await fac.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** Decodes a base64 JSON header. */
export function b64json(v: string | string[] | number | undefined): any {
  return JSON.parse(Buffer.from(String(v), 'base64').toString('utf8'));
}
