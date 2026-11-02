import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  HEADER,
  decodeBase64Strict,
  derivedRequestId,
  isChallengeHeader,
  isRequestIdHeader,
  jcs,
  parsePayerSig,
  payerSigDigest,
  recoverDigestSigner,
  requestHash as computeRequestHash,
  type GatewayErrorCode,
} from '@attessa/core';
import type { Address, Hex } from 'viem';
import type { Chain } from './chain.ts';
import { MAX_BODY_BYTES, checkProof, validateBody } from './checks.ts';
import type { GatewayConfig } from './config.ts';
import { RESULT_RETENTION_S, type CallRow, type CallStore } from './db.ts';
import { errorAnswer, type ErrorAnswer, type ErrorContext } from './errors.ts';
import type { Facilitator } from './facilitator.ts';
import { RateLimiter } from './ratelimit.ts';
import { Reconciler } from './reconciler.ts';
import type { SellerHost } from './sellerhost.ts';
import { handlerSettle, paymentResponseHeader, targetOf } from './settle.ts';
import {
  buildAccepts,
  buildPaymentRequired,
  decodePaymentSignature,
  encodeHeaderJson,
  matchAccepted,
  recoverAuthorizationSigner,
  type DecodedPayment,
  type PaymentRequirements,
} from './x402.ts';

export interface GatewayDeps {
  cfg: GatewayConfig;
  db: CallStore;
  chain: Chain;
  facilitator: Facilitator;
  sellerHost: SellerHost;
  /** Unix seconds. */
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** Fastify `trustProxy` (Caddy on loopback in production). */
  trustProxy?: boolean | string;
}

/** SPEC §6.1 per-IP limits per minute. */
export const LIMITS = { wellKnown: 120, liveness: 30, evaluateUnpaid: 120, results: 60, static: 120 } as const;
export const IN_FLIGHT_CAP = 16;
/** SPEC §6.2 step 3 and step 10. */
export const MIN_WINDOW_S = 40;
export const MIN_SETTLE_WINDOW_S = 10;
/** SPEC §2.5: `X-Attest-Payer-Sig` accepted within 300 s of gateway time. */
export const PAYER_SIG_WINDOW_S = 300;
/** Blocks subtracted from the head when recording `created_block`, so a log query never starts after the authorization's use. */
export const CREATED_BLOCK_MARGIN = 20n;

const STORED_RESULT_STATES = ['settled', 'delivered', 'delivery_failed'];
const PENDING_STATES = ['settling', 'settle_pending'];
const RUNNING_STATES = ['payment_verified', 'executing'];

class Fail {
  readonly answer: ErrorAnswer;
  constructor(answer: ErrorAnswer) {
    this.answer = answer;
  }
}

/**
 * Rows a request handler is answering right now, counted per handler: a duplicate request for a `settled` row
 * can be delivering it while the first handler still is (SPEC §6.2 step 4 releases the lock before step 12).
 * `delete` drops one handler and says whether none is left.
 */
export class LiveRows {
  private readonly n = new Map<string, number>();
  has(requestId: string): boolean {
    return this.n.has(requestId);
  }
  add(requestId: string): void {
    this.n.set(requestId, (this.n.get(requestId) ?? 0) + 1);
  }
  delete(requestId: string): boolean {
    const left = (this.n.get(requestId) ?? 1) - 1;
    if (left > 0) this.n.set(requestId, left);
    else this.n.delete(requestId);
    return left <= 0;
  }
}

export interface Gateway {
  app: FastifyInstance;
  reconciler: Reconciler;
  /** Startup sweep, one reconciler pass, then the 5 s timer. */
  start(): Promise<void>;
  close(): Promise<void>;
  /** In-process sets, exposed for tests and the reconciler. */
  sending: Set<string>;
  live: LiveRows;
}

export function createGateway(deps: GatewayDeps): Gateway {
  const { cfg, db, chain, facilitator, sellerHost } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const log = deps.log ?? ((event, fields) => process.stdout.write(`${JSON.stringify({ t: now(), event, ...fields })}\n`));
  const locks = new Set<string>();
  const sending = new Set<string>();
  const live = new LiveRows();
  const limiter = new RateLimiter(() => now());
  let inFlight = 0;
  let signerCache: { signer: Address; at: number } | null = null;

  const reconciler = new Reconciler({ cfg, db, chain, facilitator, now, sending, live, log });

  const app = Fastify({ logger: false, trustProxy: deps.trustProxy ?? '127.0.0.1', bodyLimit: MAX_BODY_BYTES });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  function send(reply: FastifyReply, a: ErrorAnswer, requestId: string | null): FastifyReply {
    reply.code(a.status).header('cache-control', 'no-store');
    for (const [k, v] of Object.entries(a.headers)) reply.header(k, v);
    if (requestId) reply.header(HEADER.requestId, requestId);
    return reply.type('application/json').send(JSON.stringify(a.body));
  }

  function fail(code: GatewayErrorCode, detail: string | null, ctx: ErrorContext, headers: Record<string, string> = {}): Fail {
    return new Fail(errorAnswer(code, detail, ctx, headers));
  }

  app.setErrorHandler((err, req, reply) => {
    const ctx: ErrorContext = { paid: req.headers['payment-signature'] !== undefined, requestId: null, correlationId: randomUUID() };
    const code = (err as { code?: string }).code;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return send(reply, errorAnswer('bad_request', `the body is over ${MAX_BODY_BYTES} bytes or unreadable`, ctx), null);
    }
    log('unhandled_error', { error: (err as Error).message, correlationId: ctx.correlationId });
    return send(reply, errorAnswer('gateway_busy', null, ctx, { [HEADER.retryAfter]: '2' }), null);
  });

  function limited(req: FastifyRequest, reply: FastifyReply, group: keyof typeof LIMITS, paid = false): FastifyReply | null {
    const r = limiter.hit(`${group}:${req.ip}`, LIMITS[group], 60);
    if (r.ok) return null;
    const ctx: ErrorContext = { paid, requestId: null, correlationId: randomUUID() };
    return send(reply, errorAnswer('rate_limited', null, ctx, { [HEADER.retryAfter]: String(r.retryAfter) }), null);
  }

  // ---- static routes (SPEC §6.1)

  app.get('/.well-known/attested-exec.json', async (req, reply) => {
    const l = limited(req, reply, 'wellKnown');
    if (l) return l;
    return reply.type('application/json').send(
      JSON.stringify({
        v: '1',
        chainId: String(cfg.chainId),
        registry: cfg.registry,
        agentId: cfg.agentId.toString(10),
        origin: cfg.origin,
        resources: [{ path: '/v1/evaluate', method: 'POST' }],
      }),
    );
  });

  app.get('/healthz', async (req, reply) => {
    const l = limited(req, reply, 'static');
    if (l) return l;
    return reply.type('application/json').send('{"ok":true}');
  });

  const staticFiles: Record<string, string> = { '/privacy': 'privacy.txt', '/terms': 'terms.txt', '/.well-known/security.txt': 'security.txt' };
  for (const [route, file] of Object.entries(staticFiles)) {
    app.get(route, async (req, reply) => {
      const l = limited(req, reply, 'static');
      if (l) return l;
      if (!cfg.staticDir) return reply.code(404).type('text/plain').send('Not found');
      try {
        const text = await readFile(join(cfg.staticDir, file), 'utf8');
        return reply.type('text/plain; charset=utf-8').send(text);
      } catch {
        return reply.code(404).type('text/plain').send('Not found');
      }
    });
  }

  // ---- liveness (SPEC §6.1)

  app.post('/v1/liveness', async (req, reply) => {
    const l = limited(req, reply, 'liveness');
    if (l) return l;
    const ctx: ErrorContext = { paid: false, requestId: null, correlationId: randomUUID() };
    let challenge: unknown;
    try {
      challenge = (JSON.parse((req.body as Buffer | undefined)?.toString('utf8') ?? '') as { challenge?: unknown }).challenge;
    } catch {
      challenge = undefined;
    }
    if (typeof challenge !== 'string' || !isChallengeHeader(challenge)) {
      return send(reply, errorAnswer('bad_request', 'challenge must be 0x + 64 lowercase hex', ctx), null);
    }
    try {
      const out = await sellerHost.liveness(challenge as Hex, cfg.timeouts.sellerHostMs);
      return reply.type('application/json').send(JSON.stringify(out));
    } catch {
      return send(reply, errorAnswer('enclave_unavailable', null, ctx, { [HEADER.retryAfter]: '30' }), null);
    }
  });

  // ---- results (SPEC §6.1)

  app.get('/v1/results/:requestId', async (req, reply) => {
    const l = limited(req, reply, 'results');
    if (l) return l;
    const requestId = (req.params as { requestId: string }).requestId;
    const ctx: ErrorContext = { paid: true, requestId: isRequestIdHeader(requestId) ? requestId : null, correlationId: randomUUID() };
    const notFound = () => send(reply, errorAnswer('result_not_found', null, ctx), ctx.requestId);
    if (!isRequestIdHeader(requestId)) return notFound();
    const sigHeader = req.headers['x-attest-payer-sig'];
    const parsed = typeof sigHeader === 'string' ? parsePayerSig(sigHeader) : null;
    if (!parsed || Math.abs(parsed.unixSeconds - now()) > PAYER_SIG_WINDOW_S) return notFound();
    const row = db.byRequestId(requestId);
    if (!row) return notFound();
    const recovered = await recoverDigestSigner(payerSigDigest(requestId as Hex, parsed.unixSeconds), parsed.signature);
    if (recovered === null || recovered !== row.payer) return notFound();
    if (PENDING_STATES.includes(row.state)) return pendingAnswer(reply, row, ctx);
    if (STORED_RESULT_STATES.includes(row.state) && row.response !== null && row.proof_header !== null) {
      return storedResult(reply, row, null);
    }
    return notFound();
  });

  function pendingAnswer(reply: FastifyReply, row: CallRow, ctx: ErrorContext): FastifyReply {
    const headers: Record<string, string> = { [HEADER.retryAfter]: '3' };
    if (row.settle_tx) headers[HEADER.paymentResponse] = paymentResponseHeader(cfg, row, false);
    return send(
      reply,
      errorAnswer('settle_pending', row.settle_tx ? `tx ${row.settle_tx}` : null, { ...ctx, validBefore: row.valid_before, tx: row.settle_tx }, headers),
      row.request_id,
    );
  }

  /**
   * Marks the row live for this reply. The mark is tied to the reply's own end at once, so it is dropped on
   * every path the response can end by (written, client gone, stream error), even one that ends before the
   * handler gets to write. A reply that has already ended (its client left during execution, the lock or
   * the signature check) can no longer emit that end, so it takes no mark at all. The connection's own close
   * also ends the mark: a pipelined request's response that was never attached to the socket emits neither
   * `finish` nor `close` (Node 22). The reconciler's LIVE_DEADLINE_S bounds any gap left. `deliver()` makes this
   * reply the row's delivery (SPEC §6.2 step 12): written → `delivered`; ended unwritten with no other
   * handler delivering → `delivery_failed`. `release()` drops the mark early when the reply will not carry
   * the result.
   */
  function holdLive(reply: FastifyReply, requestId: string): { deliver(): void; release(): void } {
    const res = reply.raw;
    const sock = reply.request.raw.socket as Socket | null;
    let held = !(res.destroyed || res.closed || res.writableEnded || sock?.destroyed);
    if (held) live.add(requestId);
    let delivering = false;
    let finished = false;
    const end = (): void => {
      if (!held) return;
      held = false;
      sock?.off('close', end); // a kept-alive connection outlives this reply
      const last = live.delete(requestId);
      if (!delivering) return;
      if (finished) db.transition(requestId, ['settled'], 'delivered', now());
      // Another handler still delivering this row decides its outcome (and keeps the reconciler off it).
      else if (last) db.transition(requestId, ['settled'], 'delivery_failed', now());
    };
    if (held) {
      res.once('finish', () => {
        finished = true;
        end();
      });
      res.once('close', end);
      sock?.once('close', end);
    }
    return {
      deliver() {
        if (!held) {
          // The client left before a byte was written: a failed delivery, unless another handler is delivering.
          // (A written reply cannot be here: writing starts only after deliver().)
          if (!live.has(requestId)) db.transition(requestId, ['settled'], 'delivery_failed', now());
          return;
        }
        delivering = true;
      },
      release() {
        end();
      },
    };
  }

  /** The stored result: exact bytes + `X-Attested-Proof` + `PAYMENT-RESPONSE` + `X-Request-Id` (SPEC §6.2 step 12). */
  function storedResult(reply: FastifyReply, row: CallRow, hold: { deliver(): void } | null): FastifyReply {
    hold?.deliver();
    return reply
      .code(200)
      .header('cache-control', 'no-store')
      .header('content-type', 'application/json')
      .header('content-encoding', 'identity')
      .header(HEADER.attestedProof, row.proof_header as string)
      .header(HEADER.paymentResponse, paymentResponseHeader(cfg, row, true))
      .header(HEADER.requestId, row.request_id)
      .send(row.response as Buffer);
  }

  /** Repeats a terminal failure row's error (SPEC §6.2 step 4, idempotent). */
  function repeatFailure(row: CallRow, ctx: ErrorContext): ErrorAnswer {
    const r = row.reject_reason ?? 'enclave_unavailable';
    switch (row.state) {
      case 'proof_rejected':
        return errorAnswer('proof_rejected', r, ctx);
      case 'too_late':
        return errorAnswer('authorization_expiring', null, ctx);
      case 'settle_failed':
        return errorAnswer('settle_failed', r, ctx);
      default:
        if (r === 'execution_timeout') return errorAnswer('execution_timeout', null, ctx);
        if (r === 'bad_request') return errorAnswer('bad_request', 'the service refused this input', ctx);
        return errorAnswer('enclave_unavailable', null, ctx, { [HEADER.retryAfter]: '30' });
    }
  }

  async function currentSigner(): Promise<Address> {
    const t = now();
    if (signerCache && (t - signerCache.at) * 1000 < cfg.timeouts.signerRefreshMs) return signerCache.signer;
    const { signer } = await sellerHost.attest(cfg.timeouts.sellerHostMs);
    signerCache = { signer, at: t };
    return signer;
  }

  // ---- POST /v1/evaluate (SPEC §6.2)

  app.post('/v1/evaluate', async (req, reply) => {
    const paid = req.headers['payment-signature'] !== undefined;
    const ctx: ErrorContext = { paid, requestId: null, correlationId: randomUUID() };
    if (!paid) {
      const l = limited(req, reply, 'evaluateUnpaid');
      if (l) return l;
    }
    if (inFlight >= IN_FLIGHT_CAP) return send(reply, errorAnswer('gateway_busy', null, ctx, { [HEADER.retryAfter]: '2' }), null);
    inFlight++;
    try {
      return await evaluate(req, reply, ctx);
    } catch (e) {
      if (e instanceof Fail) return send(reply, e.answer, ctx.requestId);
      throw e;
    } finally {
      inFlight--;
    }
  });

  async function evaluate(req: FastifyRequest, reply: FastifyReply, ctx: ErrorContext): Promise<FastifyReply> {
    // 0. Paused: no verify, no execution.
    if (db.isPaused()) throw fail('gateway_paused', null, ctx, { [HEADER.retryAfter]: '300' });
    const ridHeader = req.headers['x-request-id'];
    if (ridHeader !== undefined) {
      if (typeof ridHeader !== 'string' || !isRequestIdHeader(ridHeader)) {
        throw fail('bad_request', 'X-Request-Id must be 0x + 64 lowercase hex', ctx);
      }
      ctx.requestId = ridHeader;
    }
    // 1. Body against §4.3, before any payment.
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const bad = validateBody(body, cfg.chainId);
    if (bad) throw fail('bad_request', bad, ctx);

    // 2. No PAYMENT-SIGNATURE → 402 quote.
    const sigHeader = req.headers['payment-signature'];
    if (sigHeader === undefined) return quote(req, reply, ctx);
    if (typeof sigHeader !== 'string') throw fail('payment_invalid', 'invalid_payload', ctx);

    // 3. Decode and match the accepted requirement.
    const decoded = decodePaymentSignature(sigHeader);
    if ('ok' in decoded) throw fail('payment_invalid', decoded.reason, ctx);
    const offers = buildAccepts(cfg, null);
    const req402 = matchAccepted(decoded.accepted, offers);
    if (!req402) throw fail('payment_invalid', 'requirements_mismatch', ctx);
    const a = decoded.authorization;
    if (req402.network !== cfg.x402Network || a.to !== req402.payTo || a.value !== req402.amount) {
      throw fail('payment_invalid', 'requirements_mismatch', ctx);
    }
    const validBefore = Number(a.validBefore);
    if (!Number.isSafeInteger(validBefore)) throw fail('authorization_window_too_short', null, ctx);
    const asset = req402.asset;
    const requestId = (ctx.requestId ?? derivedRequestId(asset, a.from, a.nonce)) as Hex;
    ctx.requestId = requestId;
    const reqHash = computeRequestHash(req.method, req.url, body);

    // 4. Idempotency, under an in-process lock on both keys.
    const keys = [`rid:${requestId}`, `pay:${asset}:${a.from}:${a.nonce}`];
    if (keys.some((k) => locks.has(k))) throw fail('in_progress', null, ctx, { [HEADER.retryAfter]: '2' });
    keys.forEach((k) => locks.add(k));
    try {
      const byReq = db.byRequestId(requestId);
      const byPay = db.byPayment(asset, a.from, a.nonce);
      if (byReq || byPay) return await existing(reply, ctx, decoded, req402, requestId, reqHash, byReq, byPay);
      // The 40 s window applies to a new payment. A repeat of a known one follows the idempotency table
      // even when its window has since shrunk, so a stored result is never refused as "too short".
      if (validBefore - now() < MIN_WINDOW_S) throw fail('authorization_window_too_short', null, ctx);

      // 5. Facilitator /verify. No row is written for an unverified payment.
      const vreq = { x402Version: 2 as const, paymentPayload: decoded.paymentPayload, paymentRequirements: decoded.accepted };
      let payer: Address;
      try {
        const v = await facilitator.verify(vreq, cfg.timeouts.verifyMs);
        const vb = v.body as { isValid?: unknown; invalidReason?: unknown; payer?: unknown } | null;
        if (vb && vb.isValid === false) {
          const reason = typeof vb.invalidReason === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(vb.invalidReason) ? vb.invalidReason : 'invalid';
          throw fail('payment_invalid', reason, ctx);
        }
        if (v.status < 200 || v.status >= 300 || !vb || vb.isValid !== true) throw fail('payment_invalid', 'unexpected_verify_error', ctx);
        // Step 6 takes the payer from /verify, so a valid answer must name one.
        if (typeof vb.payer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(vb.payer)) throw fail('payment_invalid', 'unexpected_verify_error', ctx);
        payer = vb.payer.toLowerCase() as Address;
        if (payer !== a.from) throw fail('payment_invalid', 'payer_mismatch', ctx);
      } catch (e) {
        if (e instanceof Fail) throw e;
        throw fail('payment_invalid', 'unexpected_verify_error', ctx);
      }
      // Per-payer unsettled limit, now that the payer is verified.
      if (db.countUnsettledSince(payer, now() - 3600) >= cfg.unsettledLimitPerHour) {
        throw fail('rate_limited', null, ctx, { [HEADER.retryAfter]: '600' });
      }
      let head: bigint;
      try {
        head = await chain.blockNumber();
      } catch {
        throw fail('enclave_unavailable', null, ctx, { [HEADER.retryAfter]: '30' });
      }
      // 6. Row `payment_verified`.
      db.insertVerified(
        {
          request_id: requestId,
          payer,
          asset,
          pay_to: req402.payTo,
          amount: req402.amount,
          auth_nonce: a.nonce,
          valid_before: validBefore,
          request_hash: reqHash,
          created_block: Number(head > CREATED_BLOCK_MARGIN ? head - CREATED_BLOCK_MARGIN : 0n),
        },
        now(),
      );
    } finally {
      keys.forEach((k) => locks.delete(k));
    }
    return execute(reply, ctx, decoded, req402, requestId, reqHash, body, sigHeader, req.method, req.url);
  }

  async function quote(req: FastifyRequest, reply: FastifyReply, ctx: ErrorContext): Promise<FastifyReply> {
    let liveness: unknown = null;
    const ch = req.headers['x-attest-challenge'];
    if (ch !== undefined) {
      if (typeof ch !== 'string' || !isChallengeHeader(ch)) throw fail('bad_request', 'X-Attest-Challenge must be 0x + 64 lowercase hex', ctx);
      try {
        liveness = await sellerHost.liveness(ch as Hex, cfg.timeouts.sellerHostMs);
      } catch {
        liveness = null;
      }
    }
    const pr = buildPaymentRequired(cfg, liveness);
    reply.code(402).header('cache-control', 'no-store').header(HEADER.paymentRequired, encodeHeaderJson(pr));
    if (ctx.requestId) reply.header(HEADER.requestId, ctx.requestId);
    return reply.type('application/json').send(jcs(pr));
  }

  async function existing(
    reply: FastifyReply,
    ctx: ErrorContext,
    d: DecodedPayment,
    req402: PaymentRequirements,
    requestId: Hex,
    reqHash: Hex,
    byReq: CallRow | undefined,
    byPay: CallRow | undefined,
  ): Promise<FastifyReply> {
    const a = d.authorization;
    const row = (byReq ?? byPay) as CallRow;
    const samePairing =
      byReq !== undefined &&
      byPay !== undefined &&
      byReq.request_id === byPay.request_id &&
      row.request_hash === reqHash &&
      row.pay_to === a.to &&
      row.amount === a.value &&
      row.valid_before === Number(a.validBefore);
    if (!samePairing) {
      const code = byPay && (byPay.request_id !== requestId || byPay.request_hash !== reqHash) ? 'payment_reused' : 'request_id_conflict';
      throw fail(code, null, ctx);
    }
    if (STORED_RESULT_STATES.includes(row.state)) {
      // Releasing stored bytes needs proof that the presenter holds the payer's signature for this authorization.
      const signer = await recoverAuthorizationSigner(cfg.chainId, req402, a, d.signature);
      if (signer !== row.payer) throw fail('payment_reused', null, ctx);
      if (row.response === null || row.proof_header === null) throw fail('result_not_found', null, ctx);
      return storedResult(reply, row, row.state === 'settled' ? holdLive(reply, row.request_id) : null);
    }
    if (PENDING_STATES.includes(row.state)) return pendingAnswer(reply, row, ctx);
    if (RUNNING_STATES.includes(row.state)) throw fail('in_progress', null, ctx, { [HEADER.retryAfter]: '2' });
    throw new Fail(repeatFailure(row, ctx));
  }

  async function execute(
    reply: FastifyReply,
    ctx: ErrorContext,
    d: DecodedPayment,
    req402: PaymentRequirements,
    requestId: Hex,
    reqHash: Hex,
    body: Buffer,
    sigHeader: string,
    method: string,
    url: string,
  ): Promise<FastifyReply> {
    const a = d.authorization;
    const execFailed = (code: 'enclave_unavailable' | 'execution_timeout' | 'bad_request', headers: Record<string, string> = {}): Fail => {
      db.transition(requestId, ['payment_verified', 'executing'], 'exec_failed', now(), { reject_reason: code });
      return fail(code, code === 'bad_request' ? 'the service refused this input' : null, ctx, headers);
    };
    try {
      // 7. Signer pre-check.
      let claimed: Address;
      try {
        claimed = await currentSigner();
        const sc = await chain.checkSigner(cfg.registry, claimed, cfg.originHash);
        if (sc.code !== 'OK') throw new Error(sc.code);
      } catch {
        throw execFailed('enclave_unavailable', { [HEADER.retryAfter]: '30' });
      }
      // 8. Execute.
      db.transition(requestId, ['payment_verified'], 'executing', now());
      let out;
      try {
        out = await sellerHost.evaluate(
          { requestId, method: method.toUpperCase(), path: url, body: body.toString('base64'), paymentId: a.nonce },
          cfg.timeouts.executeMs,
        );
      } catch (e) {
        const name = (e as { name?: string }).name;
        if (name === 'TimeoutError' || name === 'AbortError') throw execFailed('execution_timeout');
        throw execFailed('enclave_unavailable', { [HEADER.retryAfter]: '30' });
      }
      if (!out.ok) {
        if (out.error === 'bad_request') throw execFailed('bad_request');
        throw execFailed('enclave_unavailable', { [HEADER.retryAfter]: '30' });
      }
      // 9. Proof check.
      const responseBytes = decodeBase64Strict(out.response);
      const rejected = (check: string): Fail => {
        db.transition(requestId, ['executing'], 'proof_rejected', now(), { reject_reason: check });
        log('proof_rejected', { requestId, check });
        return fail('proof_rejected', check, ctx);
      };
      if (!responseBytes) throw rejected('response_hash_mismatch');
      const pc = await checkProof({
        cfg,
        chain,
        now: now(),
        claimedSigner: claimed,
        requestId,
        requestHash: reqHash,
        nonce: a.nonce,
        responseBytes,
        proofJson: out.proof,
        signature: out.signature,
      });
      if (!pc.ok) throw rejected(pc.check);
      // 10. Too close to expiry.
      if (Number(a.validBefore) - now() < MIN_SETTLE_WINDOW_S) {
        db.transition(requestId, ['executing'], 'too_late', now(), { reject_reason: 'authorization_expiring' });
        throw fail('authorization_expiring', null, ctx);
      }
      // 11. Persist, then settle.
      const persisted = db.persistForSettle(
        requestId,
        { response: Buffer.from(responseBytes), proof_header: pc.proofHeader, payment_payload: sigHeader.trim(), requirements: jcs(d.accepted) },
        now(),
      );
      if (!persisted) throw execFailed('enclave_unavailable');
    } catch (e) {
      if (e instanceof Fail) throw e;
      // Anything unexpected before persisting: never settle.
      throw execFailed('enclave_unavailable', { [HEADER.retryAfter]: '30' });
    }

    sending.add(requestId);
    const hold = holdLive(reply, requestId);
    let row: CallRow;
    try {
      const target = targetOf(db.byRequestId(requestId) as CallRow);
      const outcome = await handlerSettle(
        { cfg, chain, facilitator, now },
        target,
        { x402Version: 2, paymentPayload: d.paymentPayload, paymentRequirements: d.accepted },
      );
      if (outcome.kind === 'settled') {
        const t = now();
        db.transition(requestId, ['settling', 'settle_pending'], 'settled', t, {
          settle_tx: outcome.tx,
          reject_reason: null,
          result_expires_at: t + RESULT_RETENTION_S,
        });
      } else {
        db.transition(requestId, ['settling'], 'settle_pending', now(), {
          reject_reason: outcome.reason,
          ...(outcome.tx ? { settle_tx: outcome.tx } : {}),
        });
        if (outcome.pause) {
          db.setPaused(true);
          log('facilitator_auth_or_credit', { requestId });
        }
      }
    } catch (e) {
      log('settle_error', { requestId, error: (e as Error).message });
      db.transition(requestId, ['settling'], 'settle_pending', now(), { reject_reason: 'internal_error' });
    } finally {
      sending.delete(requestId);
      row = db.byRequestId(requestId) as CallRow;
    }
    // 12. Deliver.
    if (row.state === 'settled') return storedResult(reply, row, hold);
    hold.release();
    if (PENDING_STATES.includes(row.state)) return pendingAnswer(reply, row, ctx);
    // The reconciler may already have resolved the row while the handler waited.
    if (STORED_RESULT_STATES.includes(row.state)) return storedResult(reply, row, null);
    throw new Fail(repeatFailure(row, ctx));
  }

  return {
    app,
    reconciler,
    sending,
    live,
    async start() {
      reconciler.startupSweep();
      await reconciler.tick();
      reconciler.start();
    },
    async close() {
      await reconciler.stop();
      await app.close();
    },
  };
}
