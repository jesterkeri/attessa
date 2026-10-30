import type { Address, Hex } from 'viem';
import {
  decodeAttestedProof,
  eip712Domain,
  inputsHash,
  proofDigest,
  recoverDigestSigner,
  responseHash,
  PROOF_TTL,
  type ExecutionProof,
  type ProofCheck,
} from '@attessa/core';
import type { CheckName } from './abi.ts';
import { RpcError, type Chain, type Settlement } from './chain.ts';
import type { PendingEntry } from './types.ts';

// SPEC §7 V10: every §6.2 step-9 check, judged at the time anchors of the payment.

/** `|issuedAt − verifierNow| ≤ 120` (SPEC §2.3), applied to the anchors here. */
export const MAX_SKEW = 120n;
/** Inputs may be up to 300 s older than the signing time. */
export const MAX_INPUTS_AGE = 300n;

export type VerifyOk = {
  ok: true;
  proof: ExecutionProof;
  signer: Address;
  responseHash: Hex;
  inputsHash: Hex;
  inputsBlock: bigint;
  inputsChecked: boolean;
};
export type VerifyFail = { ok: false; check: ProofCheck; proof?: ExecutionProof; signer?: Address };
export type VerifyResult = VerifyOk | VerifyFail;

/** Maps a registry `Check` to the SDK's ProofCheck. */
export function proofCheckOf(code: CheckName): ProofCheck | null {
  switch (code) {
    case 'OK':
      return null;
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
    case 'BAD_SIGNATURE':
      return 'bad_signature';
    case 'PROOF_EXPIRED':
      return 'proof_expired';
    case 'PROOF_CLOCK_SKEW':
      return 'clock_skew';
  }
}

const UINT = /^(0|[1-9][0-9]*)$/;
const H32 = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;

interface Inputs {
  block: { number: bigint; hash: Hex; timestamp: bigint };
  payTo: { address: Address; code: Hex; nonce: bigint; balanceWei: bigint };
}

/** SPEC §4.3 inputs grammar. Undefined if the response isn't the workload's JSON with a well-formed `inputs`. */
function parseInputs(raw: unknown): Inputs | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as { block?: Record<string, unknown>; payTo?: Record<string, unknown> };
  const b = r.block;
  const p = r.payTo;
  if (!b || !p) return undefined;
  const ok =
    typeof b.number === 'string' && UINT.test(b.number) &&
    typeof b.hash === 'string' && H32.test(b.hash) &&
    typeof b.timestamp === 'string' && UINT.test(b.timestamp) &&
    typeof p.address === 'string' && ADDR.test(p.address) &&
    typeof p.code === 'string' && /^0x([0-9a-f]{2})*$/.test(p.code) &&
    typeof p.nonce === 'string' && UINT.test(p.nonce) &&
    typeof p.balanceWei === 'string' && UINT.test(p.balanceWei);
  if (!ok) return undefined;
  return {
    block: { number: BigInt(b.number as string), hash: b.hash as Hex, timestamp: BigInt(b.timestamp as string) },
    payTo: {
      address: p.address as Address,
      code: p.code as Hex,
      nonce: BigInt(p.nonce as string),
      balanceWei: BigInt(p.balanceWei as string),
    },
  };
}

/** Waits (bounded) until the RPC head reaches `block`, so an `eth_call` at it is answerable. */
async function waitForHead(chain: Chain, block: bigint, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if ((await chain.latest()).number >= block) return;
    await sleep(1000);
  }
  throw new RpcError(`RPC head never reached block ${block}`);
}

/**
 * V10. Throws RpcError when the chain can't answer (the caller ends `uncertain{rpc_unavailable}`);
 * every other failure is a ProofCheck.
 */
export async function verifyPaid(
  chain: Chain,
  chainId: number,
  entry: PendingEntry,
  response: Uint8Array,
  proofHeader: string | null,
  settlement: Settlement,
  sleep: (ms: number) => Promise<void>,
): Promise<VerifyResult> {
  if (proofHeader === null || proofHeader === '') return { ok: false, check: 'missing_proof' };
  if (entry.nonce === null || entry.signedAtChain === null) throw new Error('verifyPaid: ledger entry was never signed');

  let decoded;
  try {
    decoded = decodeAttestedProof(proofHeader);
  } catch {
    return { ok: false, check: 'bad_signature' };
  }
  const { proof } = decoded;
  const fail = (check: ProofCheck, signer?: Address): VerifyFail =>
    signer === undefined ? { ok: false, check, proof } : { ok: false, check, proof, signer };

  // Recovery: the header's signer field is never trusted; it must equal the recovered address.
  const domain = eip712Domain(BigInt(chainId), chain.registry);
  const r = await recoverDigestSigner(proofDigest(domain, proof), decoded.signature);
  if (r === null || r !== decoded.signer.toLowerCase()) return fail('bad_signature');

  if (proof.requestId !== entry.requestId || proof.requestHash !== entry.requestHash) return fail('request_mismatch', r);
  const respHash = responseHash(response);
  if (proof.responseHash !== respHash) return fail('response_hash_mismatch', r);
  if (proof.paymentId !== entry.nonce) return fail('payment_mismatch', r);

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response));
  } catch {
    return fail('inputs_hash_mismatch', r);
  }
  const rawInputs = typeof body === 'object' && body !== null ? (body as { inputs?: unknown }).inputs : undefined;
  let inHash: Hex;
  try {
    if (rawInputs === undefined) return fail('inputs_hash_mismatch', r);
    inHash = inputsHash(rawInputs);
  } catch {
    return fail('inputs_hash_mismatch', r);
  }
  if (proof.inputsHash !== inHash) return fail('inputs_hash_mismatch', r);
  const inputs = parseInputs(rawInputs);
  if (!inputs) return fail('inputs_mismatch', r);

  // Time anchors: A = signing time, S = settlement block time.
  const A = BigInt(entry.signedAtChain);
  const S = settlement.timestamp;
  if (proof.expiresAt !== proof.issuedAt + PROOF_TTL) return fail('proof_expired', r);
  if (proof.issuedAt < A - MAX_SKEW || proof.issuedAt > S + MAX_SKEW) return fail('clock_skew', r);
  if (proof.agentId !== BigInt(entry.agentId)) return fail('agent_mismatch', r);

  // Signer and release status at the settlement block, else rebuilt from events.
  await waitForHead(chain, settlement.blockNumber, sleep);
  let status: { code: CheckName; agentId?: bigint; releaseId?: Hex };
  try {
    const cs = await chain.checkSigner(r, entry.originHash, settlement.blockNumber);
    status = { code: cs.code, agentId: cs.signer.agentId, releaseId: cs.signer.releaseId };
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    status = await chain.checkSignerFromEvents(r, entry.originHash, settlement.blockNumber, S);
  }
  const statusCheck = proofCheckOf(status.code);
  if (statusCheck) return fail(statusCheck, r);
  if (proof.agentId !== status.agentId) return fail('agent_mismatch', r);
  if (proof.releaseId !== status.releaseId) return fail('release_not_approved', r);

  // Inputs block: the hash and timestamp the operator claims, and its age against the anchors.
  const blk = await chain.block(inputs.block.number);
  if (blk.hash.toLowerCase() !== inputs.block.hash || blk.timestamp !== inputs.block.timestamp) return fail('inputs_mismatch', r);
  if (inputs.block.timestamp < A - MAX_INPUTS_AGE || inputs.block.timestamp > S) return fail('stale_inputs', r);

  // Inputs values at the inputs block, when the RPC still keeps that state (L23).
  let inputsChecked = true;
  try {
    const acct = await chain.account(inputs.payTo.address, inputs.block.number);
    if (acct.code !== inputs.payTo.code || acct.nonce !== inputs.payTo.nonce || acct.balance !== inputs.payTo.balanceWei)
      return fail('inputs_mismatch', r);
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    inputsChecked = false;
  }

  return {
    ok: true,
    proof,
    signer: r,
    responseHash: respHash,
    inputsHash: inHash,
    inputsBlock: inputs.block.number,
    inputsChecked,
  };
}
