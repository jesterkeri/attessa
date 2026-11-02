import type { Address, Hash, Hex, LocalAccount, Transport } from 'viem';
import type { AssetKey, ErrorCode, ExecutionProof, Network, ProofCheck } from '@attessa/core';

export type { AssetKey, ErrorCode, ExecutionProof, Network, ProofCheck };

/** SPEC §7. Atomic units, per asset. */
export interface Limits {
  maxAmountPerCall: bigint;
  dailyCap: bigint;
}

/** SPEC §7. */
export interface AttestConfig {
  network: Network;
  rpcUrl?: string;
  account: LocalAccount;
  limits: Record<AssetKey, Limits>;
  asset: AssetKey;
  dataDir: string;
  /** default true */
  waitForExpiry?: boolean;
}

/**
 * Not in SPEC §7's `AttestConfig`: injection points for tests and `--network local`. Production
 * callers pass nothing.
 */
export interface ClientOptions {
  /** EnclaveRegistry override. Required while `deployments.ts` has no address for the chain (before T10/T30) and on local forks. */
  registry?: Address;
  /** viem transport; defaults to `http(cfg.rpcUrl)`. */
  transport?: Transport;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Wall clock in ms, used only for ledger bookkeeping (createdAt, the UTC day, reservation age). Never for a payment window. */
  now?: () => number;
  /** HTTP timeout for each gateway request, ms. Default 30 s. */
  httpTimeoutMs?: number;
  /** How long V11 polls the settlement receipt, ms. SPEC §7: 10 s. */
  receiptWaitMs?: number;
}

/** SPEC §7. */
export type Outcome =
  | 'verified'
  | 'refused'
  | 'not_charged'
  | 'paid_but_rejected'
  | 'settled_after_refusal'
  | 'unattested'
  | 'stopped'
  | 'uncertain';

/** Codes the SDK adds to SPEC §10's: `in_progress` reuse, and the V7 detail. */
export type CallCode = ErrorCode | 'request_id_conflict' | 'already_used' | 'cancelled' | 'missing_nonce';

export interface CallResult {
  outcome: Outcome;
  code?: CallCode;
  /** `payment_invalid{reason}`, `proof_rejected{check}`, `liveness_failed{…}`: the part in braces. */
  detail?: string;
  check?: ProofCheck;
  requestId: Hex;
  response?: Uint8Array;
  proof?: ExecutionProof;
  signer?: Address;
  settlementTx?: Hash;
  amount?: bigint;
  asset?: Address;
  payTo?: Address;
  ownerClaimedSource?: string;
  selfVerifiedOwner?: boolean;
  /** V10: whether the inputs values were re-read at the inputs block (false when the RPC no longer keeps that state). */
  inputsChecked?: boolean;
  /** Block whose timestamp was past validBefore + 5 when `not_charged` was confirmed. */
  confirmedAtBlock?: bigint;
}

export interface ResolvedEndpoint {
  origin: string;
  originHash: Hex;
  chainId: number;
  registry: Address;
  agentId: bigint;
  payTo: Address;
  operator: Address;
  selfVerifiedOwner: boolean;
}

export interface LivenessResult {
  ok: boolean;
  reason?: string;
  signer?: Address;
  releaseId?: Hex;
  issuedAt?: bigint;
  latencyMs?: number;
}

/** SPEC §7 pending ledger states. */
export type LedgerState =
  | 'reserved'
  | 'signed'
  | 'refused'
  | 'uncertain'
  | 'settle_pending'
  | 'verified'
  | 'not_charged'
  | 'paid_but_rejected'
  | 'settled_after_refusal';

export const TERMINAL_STATES: readonly LedgerState[] = [
  'verified',
  'not_charged',
  'paid_but_rejected',
  'settled_after_refusal',
];
/** States whose amount is spent (SPEC §7, INV-19: paid_but_rejected and settled_after_refusal count). */
export const SETTLED_STATES: readonly LedgerState[] = ['verified', 'paid_but_rejected', 'settled_after_refusal'];
/** States whose amount is reserved (counted until released or settled). */
export const RESERVED_STATES: readonly LedgerState[] = ['reserved', 'signed', 'refused', 'uncertain', 'settle_pending'];

/**
 * SPEC §7 pending ledger entry, one JSON line in `<dataDir>/pending.jsonl`. Every value is a string
 * (or null before V8). `code`, `signedAtBlock` and `settlementTx` are additions the SPEC schema
 * doesn't list: the refusal code, the block V8 read `chainNow` from (the lower bound for log
 * queries), and the settlement tx once V11 or the reconciler found it.
 */
export interface PendingEntry {
  v: '1';
  requestId: Hex;
  origin: string;
  originHash: Hex;
  method: string;
  pathAndQuery: string;
  requestHash: Hex;
  asset: Address;
  amount: string;
  payTo: Address;
  payer: Address;
  nonce: Hex | null;
  signedAtChain: string | null;
  signedAtBlock: string | null;
  validAfter: string | null;
  validBefore: string | null;
  agentId: string;
  expectedSigner: Address | null;
  state: LedgerState;
  code: string | null;
  settlementTx: Hash | null;
  createdAt: string;
}

/** SPEC §7 evidence row. */
export interface EvidenceRow {
  v: '1';
  ts: string;
  requestId: Hex;
  origin: string;
  agentId: string | null;
  outcome: Outcome;
  code: string | null;
  check: ProofCheck | null;
  /** null on a `stopped` row written before the quote was read. */
  amount: string | null;
  asset: Address | null;
  payTo: Address | null;
  settlementTx: Hash | null;
  signer: Address | null;
  releaseId: Hex | null;
  ownerClaimedSource: string | null;
  selfVerifiedOwner: boolean | null;
  requestHash: Hex | null;
  responseHash: Hex | null;
  inputsHash: Hex | null;
  inputsBlock: string | null;
  inputsChecked: boolean | null;
  via: 'gateway' | 'buy';
}

export interface StatusReport {
  origin?: string;
  originHash?: Hex;
  agentId?: bigint;
  endpoint?: { status: 'none' | 'active' | 'retired'; payTo: Address; operator: Address };
  pending: PendingEntry[];
}
