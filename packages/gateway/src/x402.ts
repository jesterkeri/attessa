import { decodeBase64Strict, jcs } from '@attessa/core';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import type { GatewayConfig } from './config.ts';

/** x402 v2 `PaymentRequirements` as this gateway offers it (SPEC §6.2 step 2). */
export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    assetTransferMethod: 'eip3009';
    paymentFlow: 'authorization';
    attestedExec: { v: '1'; chainId: string; registry: Address; agentId: string; liveness: unknown };
  };
}

export interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

/** A decoded, grammar-checked `PAYMENT-SIGNATURE`. Addresses and the nonce are lowercased. */
export interface DecodedPayment {
  /** The payload object exactly as sent (forwarded to the facilitator unchanged). */
  paymentPayload: Record<string, unknown>;
  accepted: Record<string, unknown>;
  authorization: Authorization;
  signature: Hex;
}

export const MAX_TIMEOUT_SECONDS = 120;

export function buildAccepts(cfg: GatewayConfig, liveness: unknown): PaymentRequirements[] {
  return cfg.assets.map((a) => ({
    scheme: 'exact',
    network: cfg.x402Network,
    amount: a.amount,
    asset: a.pin.address,
    payTo: cfg.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: {
      name: a.pin.name,
      version: a.pin.version,
      assetTransferMethod: 'eip3009',
      paymentFlow: 'authorization',
      attestedExec: {
        v: '1',
        chainId: String(cfg.chainId),
        registry: cfg.registry,
        agentId: cfg.agentId.toString(10),
        liveness,
      },
    },
  }));
}

/** SPEC §6.2 step 2: the x402 v2 `PaymentRequired` object. */
export function buildPaymentRequired(cfg: GatewayConfig, liveness: unknown) {
  return {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: {
      url: `${cfg.origin}/v1/evaluate`,
      description: "Payment check. You are charged only if the response's proof verifies.",
      mimeType: 'application/json',
    },
    accepts: buildAccepts(cfg, liveness),
    extensions: {},
  };
}

/** base64 (RFC 4648, padded) of the JCS form of `value`, for `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`. */
export function encodeHeaderJson(value: unknown): string {
  return Buffer.from(jcs(value), 'utf8').toString('base64');
}

export type DecodeFailure = { ok: false; reason: 'invalid_payload' | 'requirements_mismatch' };

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

/**
 * Decodes `PAYMENT-SIGNATURE` (SPEC §2.5, §6.2 step 3): strict base64 JSON
 * `{x402Version:2, resource?, accepted, payload:{signature, authorization}, extensions?}`.
 * A structurally unreadable payload is `invalid_payload`; another x402 version is `requirements_mismatch`.
 */
export function decodePaymentSignature(header: string): DecodedPayment | DecodeFailure {
  const bytes = decodeBase64Strict(header.trim());
  if (!bytes) return { ok: false, reason: 'invalid_payload' };
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return { ok: false, reason: 'invalid_payload' };
  }
  if (!isObject(obj)) return { ok: false, reason: 'invalid_payload' };
  if (!onlyKeys(obj, ['x402Version', 'resource', 'accepted', 'payload', 'extensions'])) {
    return { ok: false, reason: 'invalid_payload' };
  }
  if (obj.x402Version !== 2) return { ok: false, reason: 'requirements_mismatch' };
  const { accepted, payload } = obj;
  if (!isObject(accepted) || !isObject(payload)) return { ok: false, reason: 'invalid_payload' };
  if (!onlyKeys(payload, ['signature', 'authorization'])) return { ok: false, reason: 'invalid_payload' };
  const { signature, authorization: a } = payload;
  if (typeof signature !== 'string' || !HEX_BYTES.test(signature)) return { ok: false, reason: 'invalid_payload' };
  if (!isObject(a) || !onlyKeys(a, ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'])) {
    return { ok: false, reason: 'invalid_payload' };
  }
  const { from, to, value, validAfter, validBefore, nonce } = a;
  if (
    typeof from !== 'string' || !HEX_ADDRESS.test(from) ||
    typeof to !== 'string' || !HEX_ADDRESS.test(to) ||
    typeof value !== 'string' || !UINT.test(value) ||
    typeof validAfter !== 'string' || !UINT.test(validAfter) ||
    typeof validBefore !== 'string' || !UINT.test(validBefore) ||
    typeof nonce !== 'string' || !HEX_BYTES32.test(nonce)
  ) {
    return { ok: false, reason: 'invalid_payload' };
  }
  return {
    paymentPayload: obj,
    accepted,
    authorization: {
      from: from.toLowerCase() as Address,
      to: to.toLowerCase() as Address,
      value,
      validAfter,
      validBefore,
      nonce: nonce.toLowerCase() as Hex,
    },
    signature: signature.toLowerCase() as Hex,
  };
}

/**
 * SPEC §6.2 step 3: `accepted` must be JCS-equal to exactly one offered entry. The offer's
 * `extra.attestedExec.liveness` differs per quote (it answers that quote's challenge), so it is the one
 * field compared by shape only: it must be present and be null or an object.
 */
export function matchAccepted(accepted: Record<string, unknown>, offers: PaymentRequirements[]): PaymentRequirements | null {
  const extra = accepted.extra;
  if (!isObject(extra) || !isObject(extra.attestedExec)) return null;
  const ae = extra.attestedExec;
  if (!('liveness' in ae) || !(ae.liveness === null || isObject(ae.liveness))) return null;
  let canon: string;
  try {
    canon = jcs({ ...accepted, extra: { ...extra, attestedExec: { ...ae, liveness: null } } });
  } catch {
    return null;
  }
  const hits = offers.filter((o) => jcs({ ...o, extra: { ...o.extra, attestedExec: { ...o.extra.attestedExec, liveness: null } } }) === canon);
  return hits.length === 1 ? (hits[0] as PaymentRequirements) : null;
}

const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** EIP-3009 typed data for an authorization under a pinned asset domain. */
export function authorizationTypedData(chainId: number, asset: Address, name: string, version: string, a: Authorization) {
  return {
    domain: { name, version, chainId, verifyingContract: asset },
    types: TRANSFER_WITH_AUTHORIZATION,
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
  };
}

/** Lowercase EOA signer of an EIP-3009 authorization, or null if the signature is not a 65-byte ECDSA one that recovers. */
export async function recoverAuthorizationSigner(
  chainId: number,
  req: PaymentRequirements,
  a: Authorization,
  signature: Hex,
): Promise<Address | null> {
  if (!/^0x[0-9a-f]{130}$/.test(signature)) return null;
  try {
    const addr = await recoverTypedDataAddress({
      ...authorizationTypedData(chainId, req.asset, req.extra.name, req.extra.version, a),
      signature,
    });
    return addr.toLowerCase() as Address;
  } catch {
    return null;
  }
}
