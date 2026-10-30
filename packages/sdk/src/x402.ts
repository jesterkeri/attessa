import type { Address, Hash, Hex, LocalAccount } from 'viem';
import { decodeBase64Strict, jcs, type PinnedAsset } from '@attessa/core';
import { EIP3009_TYPES } from './abi.ts';

// x402 v2 `exact` with EIP-3009 (SPEC §2.5, §2.6, §6.2 steps 2-3; ADR-005 amendment r5).

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,77})$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

export interface Requirement {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown> & { name: string; version: string; attestedExec: Record<string, unknown> };
}

export interface PaymentRequired {
  x402Version: 2;
  resource?: unknown;
  accepts: unknown[];
  extensions?: unknown;
}

export interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function decodeJsonHeader(v: string | null): unknown {
  if (v === null) return undefined;
  const bytes = decodeBase64Strict(v.trim());
  if (!bytes) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** `PAYMENT-REQUIRED`: base64 JSON x402 v2 `PaymentRequired`. Undefined when it isn't one. */
export function decodePaymentRequired(header: string | null): PaymentRequired | undefined {
  const pr = decodeJsonHeader(header);
  if (!isObj(pr) || pr.x402Version !== 2 || !Array.isArray(pr.accepts)) return undefined;
  return pr as unknown as PaymentRequired;
}

export interface QuoteExpectations {
  network: string;
  pin: PinnedAsset;
  chainId: number;
  registry: Address;
  agentId: bigint;
}

export type Selection =
  | { ok: true; entry: Requirement; liveness: unknown }
  | { ok: false; code: 'quote_malformed' | 'network_mismatch'; detail: string };

/**
 * V3. Picks the one entry for the configured asset and checks it against the §2.6 pins and the
 * resolved endpoint. The entry is returned as received, so `accepted` is JCS-equal to it.
 */
export function selectRequirement(pr: PaymentRequired, want: QuoteExpectations): Selection {
  const bad = (detail: string): Selection => ({ ok: false, code: 'quote_malformed', detail });
  const entries = pr.accepts.filter(isObj);
  if (entries.length !== pr.accepts.length) return bad('accepts entry is not an object');
  const pinned = want.pin.address.toLowerCase();
  const mine = entries.filter((e) => typeof e.asset === 'string' && e.asset.toLowerCase() === pinned);
  if (mine.length === 0) {
    if (entries.some((e) => e.network !== want.network)) return { ok: false, code: 'network_mismatch', detail: 'no entry on the pinned network' };
    return bad('no entry for the configured asset');
  }
  if (mine.length > 1) return bad('more than one entry for the configured asset');
  const e = mine[0]!;
  if (e.network !== want.network) return { ok: false, code: 'network_mismatch', detail: `network ${String(e.network)}` };
  if (e.scheme !== 'exact') return bad('scheme');
  if (e.asset !== pinned) return bad('asset not in the pinned lowercase form');
  if (typeof e.amount !== 'string' || !AMOUNT.test(e.amount)) return bad('amount');
  if (typeof e.payTo !== 'string' || !ADDRESS.test(e.payTo)) return bad('payTo');
  if (typeof e.maxTimeoutSeconds !== 'number' || !Number.isSafeInteger(e.maxTimeoutSeconds) || e.maxTimeoutSeconds <= 0)
    return bad('maxTimeoutSeconds');
  const x = e.extra;
  if (!isObj(x)) return bad('extra');
  if (x.name !== want.pin.name || x.version !== want.pin.version) return bad('extra.name/version differ from the pinned domain');
  if (x.assetTransferMethod !== 'eip3009') return bad('extra.assetTransferMethod');
  if (x.paymentFlow !== 'authorization') return bad('extra.paymentFlow');
  const a = x.attestedExec;
  if (!isObj(a)) return bad('extra.attestedExec');
  if (a.v !== '1') return bad('attestedExec.v');
  if (a.chainId !== String(want.chainId)) return bad('attestedExec.chainId');
  if (typeof a.registry !== 'string' || a.registry.toLowerCase() !== want.registry.toLowerCase()) return bad('attestedExec.registry');
  if (a.agentId !== want.agentId.toString()) return bad('attestedExec.agentId');
  return { ok: true, entry: e as unknown as Requirement, liveness: a.liveness };
}

/** V8: the EIP-3009 `TransferWithAuthorization` signature under the pinned token domain. */
export function signAuthorization(account: LocalAccount, chainId: number, pin: PinnedAsset, auth: Authorization): Promise<Hex> {
  if (!account.signTypedData) throw new Error('account cannot sign typed data');
  return account.signTypedData({
    domain: { name: pin.name, version: pin.version, chainId, verifyingContract: pin.address },
    types: { TransferWithAuthorization: EIP3009_TYPES.TransferWithAuthorization },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  });
}

/** `PAYMENT-SIGNATURE`: base64 of the JCS x402 v2 `PaymentPayload`. */
export function encodePaymentSignature(pr: PaymentRequired, accepted: Requirement, auth: Authorization, signature: Hex): string {
  const payload: Obj = {
    x402Version: 2,
    accepted,
    payload: { signature, authorization: auth },
    extensions: {},
  };
  if (pr.resource !== undefined) payload.resource = pr.resource;
  return Buffer.from(jcs(payload), 'utf8').toString('base64');
}

/** `PAYMENT-RESPONSE`: the settlement tx hash when the header says `success:true`. */
export function decodePaymentResponse(header: string | null): { success: boolean; transaction?: Hash } | undefined {
  const r = decodeJsonHeader(header);
  if (!isObj(r) || typeof r.success !== 'boolean') return undefined;
  const tx = typeof r.transaction === 'string' && TX.test(r.transaction) ? (r.transaction.toLowerCase() as Hash) : undefined;
  return tx === undefined ? { success: r.success } : { success: r.success, transaction: tx };
}

/** SPEC §10 error body: `{"error","detail","message","suggestion","correlationId","requestId"}`. */
export interface ErrorBody {
  error: string;
  detail: string | null;
  message: string;
  suggestion: string;
  correlationId: string;
  requestId: string | null;
}

/** Parses a §10 body; undefined unless it is one (a proxy page, an empty body and stray JSON are not). */
export function parseErrorBody(text: string): ErrorBody | undefined {
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObj(b)) return undefined;
  const str = (k: string) => typeof b[k] === 'string';
  if (!str('error') || !str('message') || !str('suggestion') || !str('correlationId')) return undefined;
  if (b.detail !== undefined && b.detail !== null && !str('detail')) return undefined;
  if (b.requestId !== undefined && b.requestId !== null && !str('requestId')) return undefined;
  return {
    error: b.error as string,
    detail: (b.detail as string | null | undefined) ?? null,
    message: b.message as string,
    suggestion: b.suggestion as string,
    correlationId: b.correlationId as string,
    requestId: (b.requestId as string | null | undefined) ?? null,
  };
}

export const isDecimal = (v: unknown): v is string => typeof v === 'string' && DEC.test(v);
