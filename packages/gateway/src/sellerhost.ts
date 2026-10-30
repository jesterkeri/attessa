import type { Address, Hex } from 'viem';

/**
 * Seller-host's internal routes (SPEC §5): `/internal/evaluate`, `/internal/liveness`, `/internal/attest`.
 * Bodies pass the enclave's messages through (SPEC §4.2).
 */

/** What the gateway sends to `/internal/evaluate`: the enclave `evaluate` message minus `type` and `inputs`. */
export interface EvaluateRequest {
  requestId: Hex;
  method: string;
  path: string;
  /** base64 of the buyer's exact body bytes. */
  body: string;
  paymentId: Hex;
}

export type EvaluateResult =
  | { ok: true; response: string; proof: unknown; signature: string }
  /** `bad_request`, `bad_inputs`, `inputs_unavailable`, `bad_frame`, `not_configured`, … */
  | { ok: false; error: string };

export interface SellerHost {
  /** Throws when seller-host is unreachable or answers without a signer. */
  attest(timeoutMs: number): Promise<{ signer: Address }>;
  liveness(challenge: Hex, timeoutMs: number): Promise<unknown>;
  /** Throws on timeout (`name === 'TimeoutError'`) and when unreachable. */
  evaluate(req: EvaluateRequest, timeoutMs: number): Promise<EvaluateResult>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class HttpSellerHost implements SellerHost {
  private readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  async attest(timeoutMs: number): Promise<{ signer: Address }> {
    const { status, json } = await this.post('/internal/attest', {}, timeoutMs);
    if (status !== 200 || !isObject(json) || typeof json.signer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(json.signer)) {
      throw new Error(`seller-host attest: HTTP ${status}`);
    }
    return { signer: json.signer.toLowerCase() as Address };
  }

  async liveness(challenge: Hex, timeoutMs: number): Promise<unknown> {
    const { status, json } = await this.post('/internal/liveness', { challenge }, timeoutMs);
    if (status !== 200 || !isObject(json) || 'error' in json) throw new Error(`seller-host liveness: HTTP ${status}`);
    return json;
  }

  async evaluate(req: EvaluateRequest, timeoutMs: number): Promise<EvaluateResult> {
    const { status, json } = await this.post('/internal/evaluate', req, timeoutMs);
    if (isObject(json) && typeof json.error === 'string') return { ok: false, error: json.error };
    if (status !== 200 || !isObject(json) || typeof json.response !== 'string' || typeof json.signature !== 'string') {
      return { ok: false, error: 'unreachable' };
    }
    return { ok: true, response: json.response, proof: json.proof, signature: json.signature };
  }
}
