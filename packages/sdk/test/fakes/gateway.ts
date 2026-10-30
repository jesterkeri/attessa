import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hashMessage, recoverAddress, recoverTypedDataAddress, type Address, type Hex, type LocalAccount } from 'viem';
import {
  decodeBase64Strict,
  eip712Domain,
  encodeAttestedProof,
  inputsHash,
  jcs,
  livenessDigest,
  livenessToJson,
  parsePayerSig,
  payerSigMessage,
  proofDigest,
  requestHash,
  responseHash,
  type ExecutionProof,
} from '@attessa/core';
import { EIP3009_TYPES } from '../../src/abi.ts';
import type { FakeChain } from './chain.ts';

// An in-process x402 v2 seller per SPEC §6, honest by default. Each `Behavior` knob turns it into
// one specific dishonest or failing gateway. It settles on the FakeChain, never on a real network.

const lc = <T extends string>(s: T) => s.toLowerCase() as T;

export interface Ctx {
  requestId: Hex;
  nonce: Hex;
  payer: Address;
  body: Uint8Array;
  pathAndQuery: string;
  inputs: Record<string, unknown>;
}

export interface Behavior {
  /** Mutates the PAYMENT-REQUIRED object before it is sent. */
  quote?: (pr: Record<string, unknown>) => void;
  /** Overrides the 402 status (e.g. 200) or answers the unpaid call with a §10 error. */
  unpaid?: (res: ServerResponse, requestId: Hex) => boolean;
  /** Liveness object override, given the honest one. */
  liveness?: (honest: Record<string, unknown>, challenge: Hex) => unknown;
  /** Inputs override. */
  inputs?: (honest: Record<string, unknown>) => Record<string, unknown>;
  /** Response bytes override, after the proof is made over the honest bytes (tampering in transit). */
  tamperResponse?: (honest: Uint8Array) => Uint8Array;
  /** Proof override before signing. */
  proof?: (p: ExecutionProof, ctx: Ctx) => ExecutionProof;
  /** Sign the proof with this key instead of the enclave's. */
  signWith?: LocalAccount;
  /** `signer` field of X-Attested-Proof. */
  headerSigner?: Address;
  /** Leave out X-Attested-Proof. */
  noProof?: boolean;
  /** What the paid request does. */
  paid?:
    | 'deliver' // settle, 200
    | 'pending' // settle, answer 202, serve /v1/results
    | 'pending_no_settle' // answer 202, never settle
    | 'proxy502_after_settle' // settle, then a proxy's HTML 502
    | 'drop_after_settle' // settle, then destroy the socket
    | 'refuse' // §10 error body, no settle
    | 'refuse_but_settle' // §10 error body, settles anyway
    | 'html502' // a proxy's HTML 502, no settle
    | 'deliver_no_settle'; // 200 with a fake tx hash, nothing on chain
  refuseWith?: { status: number; error: string; detail?: string; requestId?: string };
  /** Seconds the settlement lands after the request (chain time advances). */
  settleDelay?: number;
  /** /v1/results answers 404 even for settled calls. */
  noResults?: boolean;
  /** For `paid: 'pending'`: how many /v1/results polls answer 202 before the result is served. Default 1. */
  pendingPolls?: number;
}

export interface Paid {
  ctx: Ctx;
  payload: Record<string, unknown>;
  signatureOk: boolean;
  acceptedMatches: boolean;
  validAfter: bigint;
  validBefore: bigint;
}

export class FakeGateway {
  readonly chain: FakeChain;
  readonly agentId: bigint;
  readonly releaseId: Hex;
  readonly payTo: Address;
  readonly enclave: LocalAccount;
  origin = '';
  originHash: Hex = '0x';
  behavior: Behavior = {};
  price = '20000';
  paid: Paid[] = [];
  unpaidCalls = 0;
  results = new Map<string, { status: 'settled' | 'pending'; body: Uint8Array; proofHeader: string | null; tx: Hex | null; polls?: number }>();
  private server: Server;

  constructor(chain: FakeChain, opts: { agentId: bigint; releaseId: Hex; payTo: Address; enclave: LocalAccount }) {
    this.chain = chain;
    this.agentId = opts.agentId;
    this.releaseId = opts.releaseId;
    this.payTo = lc(opts.payTo);
    this.enclave = opts.enclave;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const port = (this.server.address() as AddressInfo).port;
    this.origin = `http://localhost:${port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private domain() {
    return eip712Domain(BigInt(this.chain.chainId), this.chain.registry);
  }

  async livenessObject(challenge: Hex): Promise<Record<string, unknown>> {
    const l = { agentId: this.agentId, releaseId: this.releaseId, originHash: this.originHash, challenge, issuedAt: this.chain.head.timestamp };
    const signature = await this.enclave.sign!({ hash: livenessDigest(this.domain(), l) });
    return { liveness: livenessToJson(l), signature };
  }

  private error(res: ServerResponse, status: number, error: string, requestId: string | null, detail?: string): void {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error, detail: detail ?? null, message: `${error}`, suggestion: 'retry_later', correlationId: 'c-1', requestId }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = new Uint8Array(Buffer.concat(chunks));
    const url = new URL(req.url!, this.origin);
    const b = this.behavior;

    if (req.method === 'GET' && url.pathname === '/.well-known/attested-exec.json') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ v: '1', chainId: String(this.chain.chainId), registry: this.chain.registry, agentId: this.agentId.toString(), origin: this.origin, resources: [{ path: '/v1/evaluate', method: 'POST' }] }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/liveness') {
      const { challenge } = JSON.parse(Buffer.from(body).toString()) as { challenge: Hex };
      const honest = await this.livenessObject(challenge);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(b.liveness ? b.liveness(honest, challenge) : honest));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/results/')) {
      const id = url.pathname.slice('/v1/results/'.length);
      const ps = parsePayerSig(String(req.headers['x-attest-payer-sig'] ?? ''));
      const row = this.results.get(id);
      const paid = this.paid.find((p) => p.ctx.requestId === id);
      if (!ps || !paid) return this.error(res, 404, 'result_not_found', id);
      const rec = lc(await recoverAddress({ hash: hashMessage(payerSigMessage(id as Hex, ps.unixSeconds)), signature: ps.signature }));
      const skew = Math.abs(ps.unixSeconds - Number(this.chain.head.timestamp));
      if (rec !== paid.ctx.payer || skew > 300) return this.error(res, 404, 'result_not_found', id);
      if (!row || b.noResults) return this.error(res, 404, 'result_not_found', id);
      if (row.status === 'pending' && row.tx && (row.polls = (row.polls ?? 0) + 1) > (b.pendingPolls ?? 1)) row.status = 'settled';
      if (row.status === 'pending') {
        res.statusCode = 202;
        res.setHeader('retry-after', '3');
        res.end(JSON.stringify({ error: 'settle_pending', detail: null, message: 'pending', suggestion: 'poll_results', correlationId: 'c', requestId: id }));
        return;
      }
      this.send200(res, id as Hex, row.body, row.proofHeader, row.tx);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/evaluate') {
      const requestId = String(req.headers['x-request-id'] ?? '') as Hex;
      const sigHeader = req.headers['payment-signature'];
      if (!sigHeader) {
        this.unpaidCalls++;
        if (b.unpaid && b.unpaid(res, requestId)) return;
        const challenge = req.headers['x-attest-challenge'] as Hex | undefined;
        const honest = challenge ? await this.livenessObject(challenge) : null;
        const liveness = b.liveness && challenge ? b.liveness(honest!, challenge) : honest;
        const pr = this.quote(liveness);
        b.quote?.(pr);
        res.statusCode = 402;
        res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(pr)).toString('base64'));
        res.end('{}');
        return;
      }
      await this.paidRequest(res, requestId, String(sigHeader), body, `${url.pathname}${url.search}`);
      return;
    }
    res.statusCode = 404;
    res.end();
  }

  quote(liveness: unknown): Record<string, unknown> {
    return {
      x402Version: 2,
      error: 'PAYMENT-SIGNATURE header is required',
      resource: { url: `${this.origin}/v1/evaluate`, description: 'Payment check. You are charged only if the response\'s proof verifies.', mimeType: 'application/json' },
      accepts: [
        {
          scheme: 'exact',
          network: `eip155:${this.chain.chainId}`,
          amount: this.price,
          asset: this.chain.asset,
          payTo: this.payTo,
          maxTimeoutSeconds: 120,
          extra: {
            name: this.chain.tokenName,
            version: this.chain.tokenVersion,
            assetTransferMethod: 'eip3009',
            paymentFlow: 'authorization',
            attestedExec: { v: '1', chainId: String(this.chain.chainId), registry: this.chain.registry, agentId: this.agentId.toString(), liveness },
          },
        },
      ],
      extensions: {},
    };
  }

  /** The workload's honest inputs: block latest − 1 and payTo's state there. */
  honestInputs(payTo: Address): Record<string, unknown> {
    const blk = this.chain.blocks.at(-2) ?? this.chain.head;
    const acct = this.chain.stateAt(blk.number).accounts[lc(payTo)] ?? { code: '0x', nonce: 0n, balance: 0n };
    return {
      block: { number: blk.number.toString(), hash: blk.hash, timestamp: blk.timestamp.toString() },
      payTo: { address: lc(payTo), code: acct.code, nonce: acct.nonce.toString(), balanceWei: acct.balance.toString() },
      source: 'forno',
    };
  }

  private async paidRequest(res: ServerResponse, requestId: Hex, sigHeader: string, body: Uint8Array, pathAndQuery: string): Promise<void> {
    const b = this.behavior;
    const bytes = decodeBase64Strict(sigHeader);
    if (!bytes) return this.error(res, 400, 'bad_request', requestId);
    const payload = JSON.parse(Buffer.from(bytes).toString()) as {
      x402Version: number;
      accepted: Record<string, unknown>;
      payload: { signature: Hex; authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex } };
    };
    const auth = payload.payload.authorization;
    const offered = this.quote(null);
    const offeredEntry = (offered.accepts as Record<string, unknown>[])[0]!;
    const acceptedMatches =
      jcs({ ...payload.accepted, extra: { ...(payload.accepted.extra as object), attestedExec: { ...((payload.accepted.extra as { attestedExec: object }).attestedExec), liveness: null } } }) ===
      jcs(offeredEntry);
    const recovered = await recoverTypedDataAddress({
      domain: { name: this.chain.tokenName, version: this.chain.tokenVersion, chainId: this.chain.chainId, verifyingContract: this.chain.asset },
      types: { TransferWithAuthorization: EIP3009_TYPES.TransferWithAuthorization },
      primaryType: 'TransferWithAuthorization',
      message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
      signature: payload.payload.signature,
    });
    const payer = lc(auth.from);
    const ctx: Ctx = { requestId, nonce: lc(auth.nonce), payer, body, pathAndQuery, inputs: {} };
    this.paid.push({ ctx, payload, signatureOk: lc(recovered) === payer, acceptedMatches, validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) });

    const mode = b.paid ?? 'deliver';
    if (mode === 'refuse' || mode === 'refuse_but_settle' || mode === 'html502' || mode === 'pending_no_settle') {
      if (mode === 'refuse_but_settle') this.doSettle(payer, auth.value, auth.nonce);
      if (mode === 'html502') {
        res.statusCode = 502;
        res.setHeader('content-type', 'text/html');
        res.end('<html><body>502 Bad Gateway</body></html>');
        return;
      }
      if (mode === 'pending_no_settle') {
        this.results.set(requestId, { status: 'pending', body: new Uint8Array(), proofHeader: null, tx: null });
        res.statusCode = 202;
        res.end(JSON.stringify({ error: 'settle_pending', detail: null, message: 'pending', suggestion: 'poll_results', correlationId: 'c', requestId }));
        return;
      }
      const r = b.refuseWith ?? { status: 502, error: 'proof_rejected', detail: 'response_hash_mismatch' };
      return this.error(res, r.status, r.error, r.requestId ?? requestId, r.detail);
    }

    // Execute: the enclave's response and proof.
    const honestInputs = this.honestInputs(this.payTo);
    const inputs = b.inputs ? b.inputs(honestInputs) : honestInputs;
    ctx.inputs = inputs;
    const honestBody = new TextEncoder().encode(jcs({ verdict: 'allow', reasons: [], rulesVersion: '1', inputs }));
    let proof: ExecutionProof = {
      agentId: this.agentId,
      releaseId: this.releaseId,
      requestId,
      requestHash: requestHash('POST', pathAndQuery, body),
      responseHash: responseHash(honestBody),
      inputsHash: inputsHash(inputs),
      paymentId: lc(auth.nonce),
      issuedAt: this.chain.head.timestamp,
      expiresAt: this.chain.head.timestamp + 600n,
    };
    if (b.proof) proof = b.proof(proof, ctx);
    const key = b.signWith ?? this.enclave;
    const signature = await key.sign!({ hash: proofDigest(this.domain(), proof) });
    const proofHeader = b.noProof ? null : encodeAttestedProof({ proof, signature, signer: b.headerSigner ?? key.address });
    const out = b.tamperResponse ? b.tamperResponse(honestBody) : honestBody;

    if (mode === 'deliver_no_settle') {
      this.send200(res, requestId, out, proofHeader, `0x${'ab'.repeat(32)}`);
      return;
    }
    const tx = this.doSettle(payer, auth.value, auth.nonce);
    if (mode === 'pending') {
      this.results.set(requestId, { status: 'pending', body: out, proofHeader, tx });
      res.statusCode = 202;
      res.setHeader('retry-after', '3');
      res.end(JSON.stringify({ error: 'settle_pending', detail: null, message: 'pending', suggestion: 'poll_results', correlationId: 'c', requestId }));
      return;
    }
    this.results.set(requestId, { status: 'settled', body: out, proofHeader, tx });
    if (mode === 'proxy502_after_settle') {
      res.statusCode = 502;
      res.setHeader('content-type', 'text/html');
      res.end('<html><body>502 Bad Gateway</body></html>');
      return;
    }
    if (mode === 'drop_after_settle') {
      res.socket?.destroy();
      return;
    }
    this.send200(res, requestId, out, proofHeader, tx);
  }

  private doSettle(payer: Address, value: string, nonce: Hex): Hex {
    if (this.behavior.settleDelay) this.chain.advance(this.behavior.settleDelay);
    return this.chain.settle(payer, this.payTo, BigInt(value), nonce);
  }

  /** Marks a pending result settled (the gateway's reconciler caught up). */
  release(requestId: Hex): void {
    const r = this.results.get(requestId);
    if (r) r.status = 'settled';
  }

  private send200(res: ServerResponse, requestId: Hex, body: Uint8Array, proofHeader: string | null, tx: Hex | null): void {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('X-Request-Id', requestId);
    if (proofHeader) res.setHeader('X-Attested-Proof', proofHeader);
    if (tx)
      res.setHeader(
        'PAYMENT-RESPONSE',
        Buffer.from(JSON.stringify({ success: true, transaction: tx, network: `eip155:${this.chain.chainId}`, payer: '0x' })).toString('base64'),
      );
    res.end(Buffer.from(body));
  }
}
