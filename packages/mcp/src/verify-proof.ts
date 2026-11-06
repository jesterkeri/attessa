import {
  DEPLOYMENTS,
  PROOF_TTL,
  decodeAttestedProof,
  eip712Domain,
  inputsHash,
  proofDigest,
  proofToJson,
  requestHash as computeRequestHash,
  recoverDigestSigner,
  responseHash,
} from '@attessa/core';

/**
 * `verify_proof`: only what a header, the registry address and the optional arguments can show with no chain and no ledger:
 * signature recovery, the fixed proof lifetime, and, for each argument given, the request id, the request hash, the response
 * hash and the inputs hash. Everything else SPEC §7 V10 checks for a paid call is named in `notChecked`; a success here is
 * not a verified paid result.
 */
export interface VerifyProofInput {
  proof: string;
  chainId: number;
  registry?: string | undefined;
  response?: string | undefined;
  requestId?: string | undefined;
  /** The request hash the caller expects (SPEC §2.2), 0x and 64 hex. */
  requestHash?: string | undefined;
  /** The request the caller says was made: hashed by SPEC §2.2 and compared with the proof's `requestHash`. */
  request?: { method: string; pathAndQuery: string; body: string } | undefined;
}

export type ProofCheckName = 'bad_signature' | 'request_mismatch' | 'response_hash_mismatch' | 'inputs_hash_mismatch' | 'proof_expired';

export interface VerifyProofOutput {
  ok: boolean;
  /** The first failed check, a SPEC §10 `proof_rejected` check name. */
  check?: ProofCheckName;
  /** Which checks ran and passed, in order. */
  passed: string[];
  signer?: string;
  proof?: Record<string, string>;
  /** `offline`: no chain, ledger or clock was read. */
  scope: 'offline';
  /** Every SPEC §7 V10 check this call did not make, by name. */
  notChecked: string[];
}

/** Needs a chain read, the ledger entry of the payment or the verifier's clock: never done here. */
const ALWAYS_NOT_CHECKED = [
  'signer_active_on_chain',
  'release_approved_on_chain',
  'endpoint_agent_operator_on_chain',
  'payment_binding', // paymentId against the signed nonce, asset, amount and payTo
  'settlement', // the settlement receipt and log
  'time_anchors', // issuedAt against the signing time and the settlement block's time
  'expiry_against_now',
  'inputs_block_and_values', // the inputs block's hash and age, and the state re-read at it
];

export function registryFor(chainId: number): string | undefined {
  return Object.values(DEPLOYMENTS).find((d) => d.chainId === chainId)?.enclaveRegistry?.toLowerCase() ?? undefined;
}

export async function verifyProof(i: VerifyProofInput, registry: string): Promise<VerifyProofOutput> {
  const optional: string[] = [];
  const notChecked = (): string[] => [...optional, ...ALWAYS_NOT_CHECKED];
  const passed: string[] = [];
  let decoded;
  try {
    decoded = decodeAttestedProof(i.proof);
  } catch {
    return { ok: false, check: 'bad_signature', passed, scope: 'offline', notChecked: notChecked() };
  }
  const { proof } = decoded;
  const fields = proofToJson(proof);
  const fail = (check: ProofCheckName, signer?: string): VerifyProofOutput => ({ ok: false, check, passed, ...(signer ? { signer } : {}), proof: fields, scope: 'offline', notChecked: notChecked() });
  const domain = eip712Domain(BigInt(i.chainId), registry as `0x${string}`);
  const r = await recoverDigestSigner(proofDigest(domain, proof), decoded.signature);
  if (r === null || r !== decoded.signer.toLowerCase()) return fail('bad_signature');
  passed.push('signature');
  if (i.requestId !== undefined && proof.requestId !== i.requestId.toLowerCase()) return fail('request_mismatch', r);
  if (i.requestId !== undefined) passed.push('request_id');
  const expectedHashes: string[] = [];
  if (i.requestHash !== undefined) expectedHashes.push(i.requestHash.toLowerCase());
  if (i.request !== undefined) expectedHashes.push(computeRequestHash(i.request.method, i.request.pathAndQuery, new TextEncoder().encode(i.request.body)));
  if (expectedHashes.some((h) => h !== proof.requestHash)) return fail('request_mismatch', r);
  if (expectedHashes.length > 0) passed.push('request_hash');
  if (proof.expiresAt !== proof.issuedAt + PROOF_TTL) return fail('proof_expired', r);
  passed.push('lifetime');
  if (i.response !== undefined) {
    const bytes = new TextEncoder().encode(i.response);
    if (proof.responseHash !== responseHash(bytes)) return fail('response_hash_mismatch', r);
    passed.push('response_hash');
    let rawInputs: unknown;
    try {
      const body: unknown = JSON.parse(i.response);
      rawInputs = typeof body === 'object' && body !== null ? (body as { inputs?: unknown }).inputs : undefined;
    } catch {
      return fail('inputs_hash_mismatch', r);
    }
    try {
      if (rawInputs === undefined || proof.inputsHash !== inputsHash(rawInputs)) return fail('inputs_hash_mismatch', r);
    } catch {
      return fail('inputs_hash_mismatch', r);
    }
    passed.push('inputs_hash');
  } else optional.push('response_hash', 'inputs_hash');
  if (expectedHashes.length === 0) optional.unshift('request_hash');
  if (i.requestId === undefined) optional.unshift('request_id');
  return { ok: true, passed, signer: r, proof: fields, scope: 'offline', notChecked: notChecked() };
}
