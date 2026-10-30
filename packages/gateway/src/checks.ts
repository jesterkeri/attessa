import {
  eip712Domain,
  encodeAttestedProof,
  inputsHash,
  proofDigest,
  proofFromJson,
  recoverDigestSigner,
  responseHash,
  type ExecutionProof,
  type ProofCheck,
} from '@attessa/core';
import type { Address, Hex } from 'viem';
import type { Chain, CheckName } from './chain.ts';
import type { GatewayConfig } from './config.ts';

/** SPEC §4.3 request body cap. */
export const MAX_BODY_BYTES = 2048;

const ADDRESS_LC = /^0x[0-9a-f]{40}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,77})$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const BODY_KEYS = ['amount', 'asset', 'chainId', 'payTo'];

/**
 * SPEC §6.2 step 1: the §4.3 strict schema, checked before any payment. Returns null when valid, else the
 * `detail` for 400 `bad_request` (FLOWS §8 "The service can't read this input: {detail}").
 */
export function validateBody(bytes: Buffer, chainId: number): string | null {
  if (bytes.length === 0) return 'the body is empty';
  if (bytes.length > MAX_BODY_BYTES) return `the body is over ${MAX_BODY_BYTES} bytes`;
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return 'the body is not JSON';
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return 'the body must be a JSON object';
  const o = obj as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== BODY_KEYS.length || keys.some((k, i) => k !== BODY_KEYS[i])) {
    return 'the body must have exactly chainId, payTo, asset and amount';
  }
  if (typeof o.chainId !== 'string' || !DEC.test(o.chainId)) return 'chainId must be a decimal string';
  if (o.chainId !== String(chainId)) return `chainId must be ${chainId}`;
  if (typeof o.payTo !== 'string' || !ADDRESS_LC.test(o.payTo)) return 'addresses must be lowercase hex';
  if (typeof o.asset !== 'string' || !ADDRESS_LC.test(o.asset)) return 'addresses must be lowercase hex';
  if (typeof o.amount !== 'string' || !AMOUNT.test(o.amount)) return 'amount must be a decimal string of at most 78 digits';
  return null;
}

/** SPEC §4.3 inputs object, as it appears in the response body. */
export interface Inputs {
  block: { number: bigint; hash: Hex; timestamp: bigint };
  payTo: { address: Address; code: Hex; nonce: bigint; balanceWei: bigint };
}

const HASH = /^0x[0-9a-f]{64}$/;
const CODE = /^0x(?:[0-9a-f]{2})*$/;

function parseInputs(v: unknown): Inputs | null {
  if (typeof v !== 'object' || v === null) return null;
  const { block, payTo } = v as Record<string, unknown>;
  if (typeof block !== 'object' || block === null || typeof payTo !== 'object' || payTo === null) return null;
  const b = block as Record<string, unknown>;
  const p = payTo as Record<string, unknown>;
  if (typeof b.number !== 'string' || !DEC.test(b.number)) return null;
  if (typeof b.hash !== 'string' || !HASH.test(b.hash)) return null;
  if (typeof b.timestamp !== 'string' || !DEC.test(b.timestamp)) return null;
  if (typeof p.address !== 'string' || !ADDRESS_LC.test(p.address)) return null;
  if (typeof p.code !== 'string' || !CODE.test(p.code)) return null;
  if (typeof p.nonce !== 'string' || !DEC.test(p.nonce)) return null;
  if (typeof p.balanceWei !== 'string' || !DEC.test(p.balanceWei)) return null;
  return {
    block: { number: BigInt(b.number), hash: b.hash as Hex, timestamp: BigInt(b.timestamp) },
    payTo: { address: p.address as Address, code: p.code as Hex, nonce: BigInt(p.nonce), balanceWei: BigInt(p.balanceWei) },
  };
}

/** registry Check → FLOWS §8 proof_rejected check. */
export function checkToProofCheck(c: CheckName): ProofCheck {
  switch (c) {
    case 'UNKNOWN_SIGNER':
    case 'SIGNER_REVOKED':
    case 'SIGNER_EXPIRED':
      return 'signer_not_active';
    case 'RELEASE_NOT_APPROVED':
      return 'release_not_approved';
    case 'ENDPOINT_INACTIVE':
    case 'ENDPOINT_MISMATCH':
      return 'endpoint_mismatch';
    case 'AGENT_MISMATCH':
      return 'agent_mismatch';
    case 'OPERATOR_MISMATCH':
      return 'operator_mismatch';
    case 'PROOF_EXPIRED':
      return 'proof_expired';
    case 'PROOF_CLOCK_SKEW':
      return 'clock_skew';
    default:
      return 'bad_signature';
  }
}

/** SPEC §2.3 / §6.2 step 9. */
export const MAX_PROOF_SKEW_S = 120n;
/** SPEC §6.2 step 9: inputs block at most 300 s old. */
export const MAX_INPUTS_AGE_S = 300n;

export interface ProofCheckInput {
  cfg: GatewayConfig;
  chain: Chain;
  now: number;
  /** The signer the gateway was told to expect (seller-host's current signer). Compared, never trusted. */
  claimedSigner: Address;
  requestId: Hex;
  requestHash: Hex;
  nonce: Hex;
  responseBytes: Uint8Array;
  proofJson: unknown;
  signature: unknown;
}

export type ProofCheckResult =
  | { ok: true; signer: Address; proof: ExecutionProof; proofHeader: string }
  | { ok: false; check: ProofCheck };

/**
 * SPEC §6.2 step 9, in order. The signer is **recovered** from the signature and that recovered address,
 * never a header field, is used for every later check. An RPC failure fails the check it was serving
 * (nothing settles on an unanswered read).
 */
export async function checkProof(x: ProofCheckInput): Promise<ProofCheckResult> {
  const fail = (check: ProofCheck): ProofCheckResult => ({ ok: false, check });
  let proof: ExecutionProof;
  try {
    proof = proofFromJson(x.proofJson);
  } catch {
    return fail('bad_signature');
  }
  if (typeof x.signature !== 'string') return fail('bad_signature');
  const domain = eip712Domain(BigInt(x.cfg.chainId), x.cfg.registry);
  const recovered = await recoverDigestSigner(proofDigest(domain, proof), x.signature);
  if (recovered === null || recovered !== x.claimedSigner.toLowerCase()) return fail('bad_signature');

  let sc;
  try {
    sc = await x.chain.checkSigner(x.cfg.registry, recovered, x.cfg.originHash);
  } catch {
    return fail('signer_not_active');
  }
  if (sc.code !== 'OK') return fail(checkToProofCheck(sc.code));
  if (proof.agentId !== sc.agentId) return fail('agent_mismatch');
  if (proof.releaseId !== sc.releaseId.toLowerCase()) return fail('release_not_approved');

  if (proof.requestId !== x.requestId) return fail('request_mismatch');
  if (proof.requestHash !== x.requestHash) return fail('request_mismatch');
  if (proof.responseHash !== responseHash(x.responseBytes)) return fail('response_hash_mismatch');
  if (proof.paymentId !== x.nonce) return fail('payment_mismatch');

  let responseJson: unknown;
  try {
    responseJson = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(x.responseBytes));
  } catch {
    return fail('inputs_hash_mismatch');
  }
  const rawInputs = typeof responseJson === 'object' && responseJson !== null ? (responseJson as Record<string, unknown>).inputs : undefined;
  if (rawInputs === undefined) return fail('inputs_hash_mismatch');
  let ih: Hex;
  try {
    ih = inputsHash(rawInputs);
  } catch {
    return fail('inputs_hash_mismatch');
  }
  if (proof.inputsHash !== ih) return fail('inputs_hash_mismatch');

  const now = BigInt(x.now);
  const skew = proof.issuedAt > now ? proof.issuedAt - now : now - proof.issuedAt;
  if (skew > MAX_PROOF_SKEW_S) return fail('clock_skew');
  if (proof.expiresAt <= now) return fail('proof_expired');

  const inputs = parseInputs(rawInputs);
  if (!inputs) return fail('inputs_mismatch');
  // Inputs block check: the block exists with that hash and timestamp, and is at most 300 s old.
  try {
    const b = await x.chain.blockByNumber(inputs.block.number);
    if (!b || b.hash.toLowerCase() !== inputs.block.hash || b.timestamp !== inputs.block.timestamp) return fail('stale_inputs');
  } catch {
    return fail('stale_inputs');
  }
  if (now - inputs.block.timestamp > MAX_INPUTS_AGE_S) return fail('stale_inputs');
  // Inputs value check: code, nonce and balance of payTo at that block.
  try {
    const a = await x.chain.accountAt(inputs.payTo.address, inputs.block.number);
    if (
      a.code.toLowerCase() !== inputs.payTo.code ||
      a.nonce !== inputs.payTo.nonce ||
      a.balance !== inputs.payTo.balanceWei
    ) {
      return fail('inputs_mismatch');
    }
  } catch {
    return fail('inputs_mismatch');
  }

  const proofHeader = encodeAttestedProof({ proof, signature: x.signature as Hex, signer: recovered });
  return { ok: true, signer: recovered, proof, proofHeader };
}
