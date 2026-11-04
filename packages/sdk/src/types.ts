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
  /**
   * Called at the points of `payAndVerify` where the CLI prints a line (FLOWS §6). Returning `'stop'` from
   * `authorizing` ends the call before anything is signed (`--dry-run`): the reservation is released and
   * the result is `stopped` with code `dry_run`.
   */
  onProgress?: (e: Progress) => void | 'stop';
  /**
   * `--dry-run`: every call ends at `authorizing`, before anything is signed, as if `onProgress` returned `'stop'`.
   * With an open entry for the same input it ends at V0 instead (`would_resume`): no payer signature, no
   * `/v1/results` request, and the ledger is left as it was.
   * It does not depend on `onProgress` at all, so a handler that throws (a closed stdout) can't turn a dry run
   * into a payment.
   */
  dryRun?: boolean;
}

/** Not in SPEC §7: the moments a caller shows progress for (FLOWS §6 J1, J2, interrupted). */
export type Progress =
  /** V0: an open ledger entry for the same input is being resumed instead of paying again. */
  | { kind: 'resuming'; entry: PendingEntry }
  /**
   * V0 under `dryRun`: an open ledger entry for the same input that a real run would resume. A dry run stops here:
   * resuming signs the payer message and asks the gateway for the result, and a preview signs and sends nothing.
   */
  | { kind: 'would_resume'; entry: PendingEntry }
  /** After V7, before V8 signs: everything checked so far. `quoteMs` is the round trip of the 402 that carried the liveness proof. */
  | {
      kind: 'authorizing';
      endpoint: ResolvedEndpoint;
      amount: bigint;
      asset: Address;
      maxAmount: bigint;
      signer: Address;
      releaseId: Hex;
      ownerClaimedSource?: string;
      quoteMs: number;
    }
  /** V9: the gateway refused a signed payment with a §10 body. */
  | { kind: 'refused'; entry: PendingEntry; code: CallCode; detail?: string }
  /** V9: no usable answer after signing (timeout, drop, a non-2xx without a §10 body, 202 polling ran out). */
  | { kind: 'uncertain'; entry: PendingEntry }
  /** V9: 202 `settle_pending`; `tx` from `PAYMENT-RESPONSE` when the gateway knows it. */
  | { kind: 'settle_pending'; entry: PendingEntry; tx: Hash | null }
  /** Refused or uncertain → final: about to wait for the chain, with the chain time it read. Once per call. */
  | { kind: 'waiting'; entry: PendingEntry; chainNow: bigint };

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
export type CallCode = ErrorCode | 'request_id_conflict' | 'already_used' | 'cancelled' | 'missing_nonce' | 'dry_run';

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
  /** The evidence row couldn't be written (full disk, permissions). The outcome stands; the ledger entry is already decided. */
  evidenceNotWritten?: true;
  /** V10: the block the inputs were read at, on a verified result. */
  inputsBlock?: bigint;
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
  /**
   * `not_charged` only: the block that decided it (the cancel's log or receipt, or the first read past expiry), so a
   * later report of the stored outcome names the same block. Absent on entries written before it existed.
   */
  confirmedAtBlock?: string | null;
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
