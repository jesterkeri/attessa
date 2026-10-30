import type { Address, Hex } from 'viem';
import { receiptSettles, type Chain } from './chain.ts';
import type { GatewayConfig } from './config.ts';
import { FacilitatorUnreachable, type Facilitator, type FacilitatorAnswer, type FacilitatorRequest } from './facilitator.ts';
import { encodeHeaderJson } from './x402.ts';
import type { CallRow } from './db.ts';

export type SettleOutcome =
  | { kind: 'settled'; tx: Hex }
  | { kind: 'pending'; reason: string; tx: Hex | null; pause: boolean };

const TX = /^0x[0-9a-fA-F]{64}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function txOf(body: unknown): Hex | null {
  return isObject(body) && typeof body.transaction === 'string' && TX.test(body.transaction)
    ? (body.transaction.toLowerCase() as Hex)
    : null;
}

function reasonOf(body: unknown, fallback: string): string {
  if (isObject(body) && typeof body.errorReason === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(body.errorReason)) {
    return body.errorReason;
  }
  return fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SettleDeps {
  cfg: GatewayConfig;
  chain: Chain;
  facilitator: Facilitator;
  now: () => number;
}

export interface SettleTarget {
  asset: Address;
  payer: Address;
  payTo: Address;
  amount: bigint;
  nonce: Hex;
  validBefore: number;
}

export function targetOf(row: CallRow): SettleTarget {
  return {
    asset: row.asset as Address,
    payer: row.payer as Address,
    payTo: row.pay_to as Address,
    amount: BigInt(row.amount),
    nonce: row.auth_nonce as Hex,
    validBefore: row.valid_before,
  };
}

/**
 * Classifies one facilitator `/settle` answer, keyed on HTTP status first (SPEC §6.2 step 11). Only a 2xx
 * `success:true` whose receipt carries both `AuthorizationUsed` and the exact `Transfer` from the asset is
 * `settled`; everything else is `pending` for the reconciler. 429 is returned as is for the caller's backoff.
 */
export async function classifySettle(
  deps: SettleDeps,
  t: SettleTarget,
  answer: FacilitatorAnswer,
): Promise<SettleOutcome | { kind: 'rate_limited'; retryAfter: number | null }> {
  const { status, body } = answer;
  if (status === 429) return { kind: 'rate_limited', retryAfter: answer.retryAfter };
  if (status === 401 || status === 402) {
    return { kind: 'pending', reason: 'facilitator_auth_or_credit', tx: txOf(body), pause: true };
  }
  if (status >= 200 && status < 300) {
    if (!isObject(body) || body.success !== true) {
      return { kind: 'pending', reason: reasonOf(body, 'success_false'), tx: txOf(body), pause: false };
    }
    const tx = txOf(body);
    if (!tx) return { kind: 'pending', reason: 'no_transaction', tx: null, pause: false };
    const deadline = performance.now() + deps.cfg.timeouts.receiptPollMs;
    for (;;) {
      let r = null;
      try {
        r = await deps.chain.receipt(tx);
      } catch {
        r = null;
      }
      if (r) {
        return receiptSettles(r, t)
          ? { kind: 'settled', tx }
          : { kind: 'pending', reason: 'receipt_without_settlement', tx, pause: false };
      }
      if (performance.now() >= deadline) return { kind: 'pending', reason: 'receipt_not_found', tx, pause: false };
      await sleep(deps.cfg.timeouts.receiptPollIntervalMs);
    }
  }
  if (status === 400 || status === 412) {
    return { kind: 'pending', reason: reasonOf(body, `http_${status}`), tx: txOf(body), pause: false };
  }
  return { kind: 'pending', reason: reasonOf(body, `http_${status}`), tx: txOf(body), pause: false };
}

/**
 * The request handler's send (SPEC §6.2 step 11): one `/settle`, re-sent after a 429 with its
 * `Retry-After` (capped at 5 s) while `validBefore − now ≥ 10`.
 */
export async function handlerSettle(deps: SettleDeps, t: SettleTarget, req: FacilitatorRequest): Promise<SettleOutcome> {
  for (;;) {
    let answer: FacilitatorAnswer;
    try {
      answer = await deps.facilitator.settle(req, deps.cfg.timeouts.settleMs);
    } catch (e) {
      const timedOut = e instanceof FacilitatorUnreachable && e.timedOut;
      return { kind: 'pending', reason: timedOut ? 'timeout' : 'network_error', tx: null, pause: false };
    }
    const out = await classifySettle(deps, t, answer);
    if (out.kind !== 'rate_limited') return out;
    const waitMs = Math.min((out.retryAfter ?? 1) * 1000, deps.cfg.timeouts.maxRetryAfterMs);
    if (t.validBefore - (deps.now() + Math.ceil(waitMs / 1000)) < 10) {
      return { kind: 'pending', reason: 'rate_limited', tx: null, pause: false };
    }
    await sleep(waitMs);
  }
}

/** `PAYMENT-RESPONSE` (x402 v2 settlement response), base64 JCS. */
export function paymentResponseHeader(cfg: GatewayConfig, row: Pick<CallRow, 'payer' | 'settle_tx'>, settled: boolean): string {
  return encodeHeaderJson(
    settled
      ? { success: true, transaction: row.settle_tx, network: cfg.x402Network, payer: row.payer }
      : { success: false, errorReason: 'settle_pending', transaction: row.settle_tx, network: cfg.x402Network, payer: row.payer },
  );
}
