import { hashMessage, type Address, type Hex } from 'viem';
import { jcs } from './jcs.ts';
import { proofFromJson, proofToJson, type ExecutionProof } from './eip712.ts';

// SPEC §2.5 header grammars.

const BYTES32 = /^0x[0-9a-f]{64}$/;
const SECONDS = /^(0|[1-9][0-9]*)$/;
const PAYER_SIG = /^(0|[1-9][0-9]*)\.(0x[0-9a-f]{130})$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
// RFC 4648 standard alphabet with padding.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const HEADER = {
  requestId: 'X-Request-Id',
  challenge: 'X-Attest-Challenge',
  paymentRequired: 'PAYMENT-REQUIRED',
  paymentSignature: 'PAYMENT-SIGNATURE',
  paymentResponse: 'PAYMENT-RESPONSE',
  attestedProof: 'X-Attested-Proof',
  payerSig: 'X-Attest-Payer-Sig',
  retryAfter: 'Retry-After',
} as const;

/** `X-Request-Id`: `0x[0-9a-f]{64}`. */
export function isRequestIdHeader(v: string): boolean {
  return BYTES32.test(v);
}

/** `X-Attest-Challenge`: `0x[0-9a-f]{64}`. */
export function isChallengeHeader(v: string): boolean {
  return BYTES32.test(v);
}

/** `Retry-After`: whole seconds. */
export function isRetryAfterHeader(v: string): boolean {
  return SECONDS.test(v);
}

/** `X-Attest-Payer-Sig`: `<unixSeconds>.<0x65-byte-hex>`. Returns null when the grammar fails. */
export function parsePayerSig(v: string): { unixSeconds: number; signature: Hex } | null {
  const m = PAYER_SIG.exec(v);
  if (!m) return null;
  const unixSeconds = Number(m[1]);
  if (!Number.isSafeInteger(unixSeconds)) return null;
  return { unixSeconds, signature: m[2] as Hex };
}

/** The ASCII string the payer `personal_sign`s: `attested-exec:results:<requestId lowercase>:<unixSeconds>`. */
export function payerSigMessage(requestId: Hex, unixSeconds: number): string {
  return `attested-exec:results:${requestId.toLowerCase()}:${unixSeconds}`;
}

/** EIP-191 digest of `payerSigMessage`, for `recoverDigestSigner`. */
export function payerSigDigest(requestId: Hex, unixSeconds: number): Hex {
  return hashMessage(payerSigMessage(requestId, unixSeconds));
}

/** Strict RFC 4648 base64 (standard alphabet, padded, canonical) to bytes, or null. */
export function decodeBase64Strict(v: string): Uint8Array | null {
  if (v === '' || !BASE64.test(v)) return null;
  const bytes = Buffer.from(v, 'base64');
  // Rejects non-zero padding bits, which Buffer would silently drop.
  if (bytes.toString('base64') !== v) return null;
  return new Uint8Array(bytes);
}

export interface AttestedProof {
  proof: ExecutionProof;
  signature: Hex;
  signer: Address;
}

/** `X-Attested-Proof`: base64 of JCS `{"proof":{…strings…},"signature":"0x…","signer":"0x…"}`. */
export function encodeAttestedProof(a: AttestedProof): string {
  const json = jcs({ proof: proofToJson(a.proof), signature: a.signature.toLowerCase(), signer: a.signer.toLowerCase() });
  return Buffer.from(json, 'utf8').toString('base64');
}

/** Parses `X-Attested-Proof`; throws on any grammar violation, including non-canonical JSON. */
export function decodeAttestedProof(v: string): AttestedProof {
  const bytes = decodeBase64Strict(v);
  if (!bytes) throw new Error('X-Attested-Proof: not strict base64');
  // ignoreBOM keeps a leading U+FEFF in the text, so JSON.parse refuses it as serde_json does.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const obj: unknown = JSON.parse(text);
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('X-Attested-Proof: not an object');
  if (jcs(obj) !== text) throw new Error('X-Attested-Proof: not JCS');
  const { proof, signature, signer, ...rest } = obj as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new Error('X-Attested-Proof: unknown field');
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) throw new Error('X-Attested-Proof: bad signature');
  if (typeof signer !== 'string' || !ADDRESS.test(signer)) throw new Error('X-Attested-Proof: bad signer');
  return { proof: proofFromJson(proof), signature: signature as Hex, signer: signer as Address };
}
