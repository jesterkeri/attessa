/** SPEC §10 error contract. `payment_invalid`, `proof_rejected` and `settle_failed` carry their reason or check in `detail`. */

export type Suggestion =
  | 'fix_request'
  | 'retry_new_request'
  | 'retry_same_request'
  | 'poll_results'
  | 'wait_or_cancel'
  | 'retry_later'
  | 'check_pending';

export interface ErrorSpec {
  http: number;
  /** As SPEC §10 writes it. */
  retryable: string;
  /** null where §10 says "per reason". */
  suggestion: Suggestion | null;
}

export const GATEWAY_ERRORS = {
  bad_request: { http: 400, retryable: 'no (fix input)', suggestion: 'fix_request' },
  payment_invalid: { http: 402, retryable: 'per reason', suggestion: null },
  authorization_window_too_short: { http: 402, retryable: 'yes', suggestion: 'retry_new_request' },
  payment_reused: { http: 409, retryable: 'no', suggestion: 'retry_new_request' },
  request_id_conflict: { http: 409, retryable: 'no', suggestion: 'retry_new_request' },
  in_progress: { http: 409, retryable: 'yes, Retry-After', suggestion: 'retry_same_request' },
  settle_pending: { http: 202, retryable: 'poll', suggestion: 'poll_results' },
  proof_rejected: { http: 502, retryable: 'no', suggestion: 'wait_or_cancel' },
  authorization_expiring: { http: 502, retryable: 'yes', suggestion: 'retry_new_request' },
  settle_failed: { http: 502, retryable: 'yes', suggestion: 'retry_new_request' },
  execution_timeout: { http: 504, retryable: 'yes (5 s)', suggestion: 'retry_new_request' },
  enclave_unavailable: { http: 503, retryable: 'yes (30 s)', suggestion: 'retry_later' },
  gateway_paused: { http: 503, retryable: 'yes (5 min)', suggestion: 'retry_later' },
  gateway_busy: { http: 503, retryable: 'yes (2 s)', suggestion: 'retry_later' },
  rate_limited: { http: 429, retryable: 'yes, Retry-After', suggestion: 'retry_later' },
  result_not_found: { http: 404, retryable: 'no', suggestion: 'check_pending' },
} as const satisfies Record<string, ErrorSpec>;

export type GatewayErrorCode = keyof typeof GATEWAY_ERRORS;

/** Codes the SDK assigns itself, without an HTTP response (SPEC §7 payAndVerify, §9 extensions). */
export const SDK_ERROR_CODES = [
  'endpoint_not_registered',
  'endpoint_retired',
  'origin_agent_mismatch',
  'rpc_unavailable',
  'quote_unavailable',
  'quote_malformed',
  'network_mismatch',
  'payto_mismatch',
  'over_max_amount',
  'over_daily_cap',
  'liveness_failed',
] as const;

export type ErrorCode = GatewayErrorCode | (typeof SDK_ERROR_CODES)[number];

/** SPEC §7. */
export type ProofCheck =
  | 'missing_proof'
  | 'bad_signature'
  | 'request_mismatch'
  | 'response_hash_mismatch'
  | 'payment_mismatch'
  | 'inputs_hash_mismatch'
  | 'inputs_mismatch'
  | 'stale_inputs'
  | 'clock_skew'
  | 'signer_not_active'
  | 'release_not_approved'
  | 'endpoint_mismatch'
  | 'agent_mismatch'
  | 'operator_mismatch'
  | 'proof_expired';

