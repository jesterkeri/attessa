import { GATEWAY_ERRORS, type GatewayErrorCode, type ProofCheck, type Suggestion } from '@attessa/core';

/** FLOWS §8 `{tail}` rule: paid requests say what the gateway did with the permission; unpaid ones that nothing was signed. */
export function tail(paid: boolean): string {
  return paid ? "Your payment permission wasn't used." : 'Nothing was signed.';
}

/** FLOWS §8 proof_rejected "{check in words}". */
const CHECK_WORDS: Record<ProofCheck, string> = {
  missing_proof: 'the answer came without a proof',
  bad_signature: "the proof wasn't signed by the registered sealed machine",
  request_mismatch: "the proof doesn't match the request you sent",
  response_hash_mismatch: "the proof doesn't match the answer's bytes",
  payment_mismatch: "the proof doesn't name your payment",
  inputs_hash_mismatch: "the proof doesn't match the chain inputs in the answer",
  inputs_mismatch: "the chain inputs in the answer don't match Celo at that block",
  stale_inputs: "the answer's chain inputs come from a block that is unknown or more than 5 minutes old",
  clock_skew: "the proof's timestamp is more than 2 minutes off",
  signer_not_active: "the signer isn't active in the registry",
  release_not_approved: "the build that signed isn't approved by the owner",
  endpoint_mismatch: "the signer isn't registered for this address",
  agent_mismatch: 'the proof names a different agent',
  operator_mismatch: "the signer's operator was replaced",
  proof_expired: 'the proof has expired',
};

const SETTLE_FAILED_WORDS: Record<string, string> = {
  nonce_used_elsewhere: 'the payment permission was used for another transfer',
  cancelled: 'the payment permission was cancelled',
  expired: 'the payment permission expired before it could be settled',
};

/** "{plain facilitator reason}" for payment_invalid. Unknown reasons are named as the facilitator sent them. */
const PAYMENT_INVALID_WORDS: Record<string, string> = {
  insufficient_funds: "the wallet doesn't hold enough to pay the price",
  invalid_payload: "the payment header couldn't be read",
  requirements_mismatch: "it doesn't match any payment option this service offered",
  payer_mismatch: 'the payment service reported a different payer than the one who signed',
  unexpected_verify_error: "the payment service couldn't check it right now",
};

export function paymentInvalidWords(reason: string): string {
  return PAYMENT_INVALID_WORDS[reason] ?? `the payment service answered "${reason}"`;
}

function formatUtc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

export interface ErrorContext {
  paid: boolean;
  requestId: string | null;
  correlationId: string;
  /** For settle_pending copy. */
  validBefore?: number;
  tx?: string | null;
}

/** FLOWS §8 copy for each §10 code, with the documented placeholders filled. */
export function message(code: GatewayErrorCode, detail: string | null, ctx: ErrorContext): string {
  const t = tail(ctx.paid);
  switch (code) {
    case 'bad_request':
      return `The service can't read this input: ${detail ?? 'the body is not valid'}. ${t}`;
    case 'payment_invalid':
      return `Not paid: the payment permission was refused because ${paymentInvalidWords(detail ?? 'unknown')}.`;
    case 'authorization_window_too_short':
      return `Your payment permission expires too soon for this service (under 40 s left). ${t}`;
    case 'payment_reused':
    case 'request_id_conflict':
      return `This request id or payment permission was already used for a different call. ${t}`;
    case 'in_progress':
      return 'This call is already running. Checking again in 2 s.';
    case 'settle_pending': {
      const until = ctx.validBefore !== undefined ? formatUtc(ctx.validBefore) : 'expiry';
      return ctx.tx
        ? `Payment sent, confirming (usually under 5 s; checking until ${until} UTC)  (tx ${ctx.tx}).`
        : `Payment sent, confirming (usually under 5 s; checking until ${until} UTC).`;
    }
    case 'proof_rejected':
      return `Refused: ${CHECK_WORDS[detail as ProofCheck] ?? detail}. ${t}`;
    case 'authorization_expiring':
      return `Not settled: your payment permission expires in under 10 s, too close to settle safely. ${t}`;
    case 'settle_failed':
      return `Payment didn't go through: ${SETTLE_FAILED_WORDS[detail ?? ''] ?? detail}. The result was withheld. ${t}`;
    case 'execution_timeout':
      return `The service didn't respond in 20 s. ${t}`;
    case 'enclave_unavailable':
      return `The service is offline. ${t}`;
    case 'gateway_paused':
      return `The service can't take payments right now. ${t}`;
    case 'gateway_busy':
    case 'rate_limited':
      return 'The service is busy. Nothing was signed.';
    case 'result_not_found':
      return `No stored result for request ${ctx.requestId ?? 'unknown'}.`;
  }
}

/** payment_invalid suggestions are per reason (SPEC §10). */
function suggestionFor(code: GatewayErrorCode, detail: string | null): Suggestion {
  const s = GATEWAY_ERRORS[code].suggestion;
  if (s !== null) return s;
  return detail === 'unexpected_verify_error' ? 'retry_later' : 'retry_new_request';
}

/** A §10 error answer: status, body `{error, detail, message, suggestion, correlationId, requestId}`, extra headers. */
export interface ErrorAnswer {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export function errorAnswer(
  code: GatewayErrorCode,
  detail: string | null,
  ctx: ErrorContext,
  headers: Record<string, string> = {},
): ErrorAnswer {
  return {
    status: GATEWAY_ERRORS[code].http,
    body: {
      error: code,
      detail,
      message: message(code, detail, ctx),
      suggestion: suggestionFor(code, detail),
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    },
    headers,
  };
}
