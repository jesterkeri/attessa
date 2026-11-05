import {
  DEPLOYMENTS,
  PROOF_TTL,
  decodeAttestedProof,
  eip712Domain,
  inputsHash,
  proofDigest,
  proofToJson,
  recoverDigestSigner,
  responseHash,
} from '@attessa/core';

/**
 * `verify_proof`: the checks of SPEC §6.2 step 9 that need no chain (signature recovery, response and inputs hashes,
 * request binding, the fixed proof lifetime). It does not read the registry, so it can't say the signer is still
 * active or the release still approved: `notChecked` says so, and `status` / `pay_and_verify` do that part.
 */
export interface VerifyProofInput {
  proof: string;
  chainId: number;
  registry?: string | undefined;
  response?: string | undefined;
  requestId?: string | undefined;
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
  notChecked: string[];
}

const NOT_CHECKED = ['signer_active_on_chain', 'release_approved_on_chain', 'payment_settled'];

export function registryFor(chainId: number): string | undefined {
  return Object.values(DEPLOYMENTS).find((d) => d.chainId === chainId)?.enclaveRegistry?.toLowerCase() ?? undefined;
}

export async function verifyProof(i: VerifyProofInput, registry: string): Promise<VerifyProofOutput> {
  const notChecked = [...NOT_CHECKED];
  const passed: string[] = [];
  let decoded;
  try {
    decoded = decodeAttestedProof(i.proof);
  } catch {
    return { ok: false, check: 'bad_signature', passed, notChecked };
  }
  const { proof } = decoded;
  const fields = proofToJson(proof);
  const fail = (check: ProofCheckName, signer?: string): VerifyProofOutput => ({ ok: false, check, passed, ...(signer ? { signer } : {}), proof: fields, notChecked });
  const domain = eip712Domain(BigInt(i.chainId), registry as `0x${string}`);
  const r = await recoverDigestSigner(proofDigest(domain, proof), decoded.signature);
  if (r === null || r !== decoded.signer.toLowerCase()) return fail('bad_signature');
  passed.push('signature');
  if (i.requestId !== undefined && proof.requestId !== i.requestId.toLowerCase()) return fail('request_mismatch', r);
  if (i.requestId !== undefined) passed.push('request_id');
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
  } else notChecked.unshift('response_hash', 'inputs_hash');
  if (i.requestId === undefined) notChecked.unshift('request_id');
  return { ok: true, passed, signer: r, proof: fields, notChecked };
}
