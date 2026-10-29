import { hashTypedData, hexToBigInt, recoverAddress, size, slice, type Address, type Hex } from 'viem';

/** SPEC §2.3 domain. `verifyingContract` is the EnclaveRegistry. */
export function eip712Domain(chainId: bigint, registry: Address) {
  return { name: 'AttestedExecution', version: '1', chainId, verifyingContract: registry } as const;
}
export type Eip712Domain = ReturnType<typeof eip712Domain>;

export const EIP712_TYPES = {
  ExecutionProof: [
    { name: 'agentId', type: 'uint256' },
    { name: 'releaseId', type: 'bytes32' },
    { name: 'requestId', type: 'bytes32' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'responseHash', type: 'bytes32' },
    { name: 'inputsHash', type: 'bytes32' },
    { name: 'paymentId', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
  Liveness: [
    { name: 'agentId', type: 'uint256' },
    { name: 'releaseId', type: 'bytes32' },
    { name: 'originHash', type: 'bytes32' },
    { name: 'challenge', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
  ],
} as const;

export interface ExecutionProof {
  agentId: bigint;
  releaseId: Hex;
  requestId: Hex;
  requestHash: Hex;
  responseHash: Hex;
  inputsHash: Hex;
  paymentId: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
}

export interface Liveness {
  agentId: bigint;
  releaseId: Hex;
  originHash: Hex;
  challenge: Hex;
  issuedAt: bigint;
}

/** SPEC §2.3: `expiresAt = issuedAt + 600`. */
export const PROOF_TTL = 600n;

export function proofDigest(domain: Eip712Domain, proof: ExecutionProof): Hex {
  return hashTypedData({ domain, types: EIP712_TYPES, primaryType: 'ExecutionProof', message: proof });
}

export function livenessDigest(domain: Eip712Domain, liveness: Liveness): Hex {
  return hashTypedData({ domain, types: EIP712_TYPES, primaryType: 'Liveness', message: liveness });
}

// ---- JSON encoding (SPEC §2.3): every field a string, integers decimal, bytes lowercase hex.

const UINT = /^(0|[1-9][0-9]*)$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const MAX_UINT64 = 2n ** 64n - 1n;
const MAX_UINT256 = 2n ** 256n - 1n;

type Field = { name: string; type: 'uint256' | 'uint64' | 'bytes32' };

function toJson(fields: readonly Field[], value: Record<string, bigint | Hex>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = value[f.name];
    out[f.name] = typeof v === 'bigint' ? v.toString(10) : (v as string).toLowerCase();
  }
  return out;
}

function fromJson(fields: readonly Field[], json: unknown): Record<string, bigint | Hex> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('expected a JSON object');
  const obj = json as Record<string, unknown>;
  const names = fields.map((f) => f.name);
  for (const k of Object.keys(obj)) if (!names.includes(k)) throw new Error(`unknown field ${k}`);
  const out: Record<string, bigint | Hex> = {};
  for (const f of fields) {
    const v = obj[f.name];
    if (typeof v !== 'string') throw new Error(`${f.name}: expected a string`);
    if (f.type === 'bytes32') {
      if (!BYTES32.test(v)) throw new Error(`${f.name}: expected 0x + 64 lowercase hex`);
      out[f.name] = v as Hex;
    } else {
      if (!UINT.test(v)) throw new Error(`${f.name}: expected a decimal string`);
      const n = BigInt(v);
      if (n > (f.type === 'uint64' ? MAX_UINT64 : MAX_UINT256)) throw new Error(`${f.name}: out of range`);
      out[f.name] = n;
    }
  }
  return out;
}

export function proofToJson(p: ExecutionProof): Record<string, string> {
  return toJson(EIP712_TYPES.ExecutionProof, { ...p });
}
export function proofFromJson(json: unknown): ExecutionProof {
  return fromJson(EIP712_TYPES.ExecutionProof, json) as unknown as ExecutionProof;
}
export function livenessToJson(l: Liveness): Record<string, string> {
  return toJson(EIP712_TYPES.Liveness, { ...l });
}
export function livenessFromJson(json: unknown): Liveness {
  return fromJson(EIP712_TYPES.Liveness, json) as unknown as Liveness;
}

// ---- Signatures (SPEC §2.3): 65 bytes r ‖ s ‖ v, v ∈ {27, 28}, high-s rejected.

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SIGNATURE = /^0x[0-9a-f]{130}$/;

/** Recovers the lowercase signer of `digest`, or null if the signature breaks a §2.3 rule or doesn't recover. */
export async function recoverDigestSigner(digest: Hex, signature: string): Promise<Address | null> {
  if (!SIGNATURE.test(signature)) return null;
  const sig = signature as Hex;
  const r = hexToBigInt(slice(sig, 0, 32));
  const s = hexToBigInt(slice(sig, 32, 64));
  const v = hexToBigInt(slice(sig, 64, 65));
  if (v !== 27n && v !== 28n) return null;
  if (r === 0n || r >= SECP256K1_N || s === 0n || s > SECP256K1_N / 2n) return null;
  if (size(digest) !== 32) return null;
  try {
    return (await recoverAddress({ hash: digest, signature: sig })).toLowerCase() as Address;
  } catch {
    return null;
  }
}
