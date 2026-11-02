import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import type { Clock, FakeChain } from './chain.ts';

/**
 * In-process x402 v2 facilitator over real HTTP. `/verify` and `/settle` follow the x402 v2 `exact` EVM
 * (EIP-3009) scheme: version, scheme, network, `accepted` equal to the requirements, recipient, value,
 * validAfter/validBefore, signature recovery under the asset's EIP-712 domain, balance, unused nonce.
 * `/settle` answers 400 with the reason before broadcasting, and 200 `success:true` after mining.
 *
 * `settleScript` overrides the next `/settle` calls in order, to reproduce the status codes of SPEC §6.2
 * step 11 (timeouts, 5xx after broadcast, 429, 401/402, success without the transfer).
 */
export type SettleBehaviour =
  | { kind: 'normal' }
  /** Never answers; broadcasts `landAfterMs` after the request arrived when set. */
  | { kind: 'hang'; landAfterMs?: number }
  /** Answers `status` with `body`; broadcasts first when `broadcast`. */
  | { kind: 'status'; status: number; body?: Record<string, unknown>; broadcast?: boolean; retryAfter?: number }
  /** 200 `success:true` naming a mined tx that carries neither AuthorizationUsed nor the Transfer. */
  | { kind: 'successWithoutTransfer' };

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

interface Check {
  ok: boolean;
  reason?: string;
  payer?: string;
  auth?: { from: Address; to: Address; value: bigint; nonce: Hex };
  asset?: Address;
}

export class FakeFacilitator {
  private server: Server | null = null;
  url = '';
  verifyCalls = 0;
  settleCalls = 0;
  supportedCalls = 0;
  settleScript: SettleBehaviour[] = [];
  /** Forces `/verify` to answer this status with no body. */
  verifyStatus: number | null = null;
  /** When set, requests must carry `Authorization: Bearer <apiKey>`, else 401. */
  apiKey: string | null = null;
  private readonly pending = new Set<ServerResponse>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly chain: FakeChain,
    private readonly clock: Clock,
    private readonly chainId: number,
  ) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    for (const r of this.pending) r.destroy();
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return null;
    }
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.apiKey !== null && req.headers.authorization !== `Bearer ${this.apiKey}`) {
      return this.json(res, 401, { error: 'unauthorized' });
    }
    if (req.method === 'GET' && req.url === '/supported') {
      this.supportedCalls++;
      return this.json(res, 200, {
        kinds: [{ x402Version: 2, scheme: 'exact', network: `eip155:${this.chainId}` }],
        extensions: [],
        signers: {},
      });
    }
    const body = await this.body(req);
    if (req.method === 'POST' && req.url === '/verify') {
      this.verifyCalls++;
      if (this.verifyStatus !== null) {
        res.writeHead(this.verifyStatus);
        return void res.end();
      }
      const c = await this.check(body);
      return this.json(res, 200, c.ok ? { isValid: true, payer: c.payer } : { isValid: false, invalidReason: c.reason, payer: c.payer ?? '' });
    }
    if (req.method === 'POST' && req.url === '/settle') {
      this.settleCalls++;
      return this.settle(body, res);
    }
    this.json(res, 404, { error: 'not found' });
  }

  private network(): string {
    return `eip155:${this.chainId}`;
  }

  /** Broadcasts the authorization on the fake chain. Returns the tx hash, or the revert reason. */
  private broadcast(c: Check): { tx: Hex } | { error: string } {
    try {
      return { tx: this.chain.transferWithAuthorization(c.asset!, c.auth!.from, c.auth!.to, c.auth!.value, c.auth!.nonce) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  private async settle(body: unknown, res: ServerResponse): Promise<void> {
    const behaviour = this.settleScript.shift() ?? { kind: 'normal' };
    const c = await this.check(body);
    const fail = (reason: string) =>
      this.json(res, 400, { success: false, errorReason: reason, payer: c.payer ?? '', transaction: '', network: this.network() });
    switch (behaviour.kind) {
      case 'hang': {
        this.pending.add(res);
        res.on('close', () => this.pending.delete(res));
        if (behaviour.landAfterMs !== undefined && c.ok) {
          const t = setTimeout(() => {
            this.timers.delete(t);
            this.broadcast(c);
          }, behaviour.landAfterMs);
          this.timers.add(t);
        }
        return;
      }
      case 'status': {
        if (behaviour.broadcast && c.ok) this.broadcast(c);
        const headers: Record<string, string> = behaviour.retryAfter !== undefined ? { 'retry-after': String(behaviour.retryAfter) } : {};
        return this.json(res, behaviour.status, behaviour.body ?? {}, headers);
      }
      case 'successWithoutTransfer': {
        const tx = this.chain.unrelatedTx();
        return this.json(res, 200, { success: true, payer: c.payer, transaction: tx, network: this.network() });
      }
      case 'normal': {
        if (!c.ok) return fail(c.reason!);
        const out = this.broadcast(c);
        if ('error' in out) return fail('invalid_transaction_state');
        return this.json(res, 200, { success: true, payer: c.payer, transaction: out.tx, network: this.network() });
      }
    }
  }

  /** x402 v2 `exact` EVM verification. */
  private async check(body: unknown): Promise<Check> {
    const b = body as { x402Version?: unknown; paymentPayload?: any; paymentRequirements?: any } | null;
    if (!b || b.x402Version !== 2) return { ok: false, reason: 'invalid_x402_version' };
    const p = b.paymentPayload;
    const r = b.paymentRequirements;
    if (!p || !r || p.x402Version !== 2) return { ok: false, reason: 'invalid_x402_version' };
    const a = p.payload?.authorization;
    const payer = typeof a?.from === 'string' ? a.from.toLowerCase() : undefined;
    const base = { payer };
    if (!isDeepStrictEqual(p.accepted, r)) return { ...base, ok: false, reason: 'invalid_payment_requirements' };
    if (r.scheme !== 'exact') return { ...base, ok: false, reason: 'unsupported_scheme' };
    if (r.network !== this.network()) return { ...base, ok: false, reason: 'invalid_network' };
    if (!a || typeof p.payload.signature !== 'string') return { ...base, ok: false, reason: 'invalid_payload' };
    if (a.to.toLowerCase() !== String(r.payTo).toLowerCase()) return { ...base, ok: false, reason: 'invalid_exact_evm_payload_recipient_mismatch' };
    if (BigInt(a.value) !== BigInt(r.amount)) return { ...base, ok: false, reason: 'invalid_exact_evm_payload_authorization_value' };
    const now = BigInt(this.clock.t);
    if (BigInt(a.validBefore) < now + 6n) return { ...base, ok: false, reason: 'invalid_exact_evm_payload_authorization_valid_before' };
    if (BigInt(a.validAfter) > now) return { ...base, ok: false, reason: 'invalid_exact_evm_payload_authorization_valid_after' };
    let signer: string;
    try {
      signer = (
        await recoverTypedDataAddress({
          domain: { name: r.extra?.name, version: r.extra?.version, chainId: this.chainId, verifyingContract: r.asset },
          types: TYPES,
          primaryType: 'TransferWithAuthorization',
          message: {
            from: a.from,
            to: a.to,
            value: BigInt(a.value),
            validAfter: BigInt(a.validAfter),
            validBefore: BigInt(a.validBefore),
            nonce: a.nonce,
          },
          signature: p.payload.signature,
        })
      ).toLowerCase();
    } catch {
      return { ...base, ok: false, reason: 'invalid_exact_evm_payload_signature' };
    }
    if (signer !== payer) return { ...base, ok: false, reason: 'invalid_exact_evm_payload_signature' };
    if (this.chain.balanceOf(r.asset, a.from) < BigInt(a.value)) return { ...base, ok: false, reason: 'insufficient_funds' };
    if (this.chain.isUsed(r.asset, a.from, a.nonce)) return { ...base, ok: false, reason: 'invalid_transaction_state' };
    return {
      ok: true,
      payer,
      asset: r.asset,
      auth: { from: a.from.toLowerCase(), to: a.to.toLowerCase(), value: BigInt(a.value), nonce: a.nonce.toLowerCase() },
    };
  }
}
