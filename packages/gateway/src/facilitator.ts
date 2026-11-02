/**
 * The x402 v2 facilitator (`/verify`, `/settle`, `/supported`) as an external HTTP service. The gateway keys
 * every settle outcome on HTTP status first (SPEC §6.2 step 11), so the client returns status and body and
 * never interprets them.
 */

export interface FacilitatorAnswer {
  status: number;
  body: unknown;
  /** Seconds, from a numeric `Retry-After` header. */
  retryAfter: number | null;
}

/** Thrown when no HTTP answer arrived: timeout, refused connection, reset, unreadable body. */
export class FacilitatorUnreachable extends Error {
  readonly timedOut: boolean;
  constructor(timedOut: boolean, message: string) {
    super(message);
    this.timedOut = timedOut;
  }
}

export interface FacilitatorRequest {
  x402Version: 2;
  paymentPayload: unknown;
  paymentRequirements: unknown;
}

export interface Facilitator {
  verify(req: FacilitatorRequest, timeoutMs: number): Promise<FacilitatorAnswer>;
  settle(req: FacilitatorRequest, timeoutMs: number): Promise<FacilitatorAnswer>;
  supported(timeoutMs: number): Promise<FacilitatorAnswer>;
}

export class HttpFacilitator implements Facilitator {
  private readonly baseUrl: string;
  /** From env `FACILITATOR_API_KEY` at runtime only; never logged. */
  private readonly apiKey: string | undefined;
  private readonly authHeader: string;
  private readonly authPrefix: string;

  constructor(baseUrl: string, apiKey: string | undefined, authHeader = 'Authorization', authPrefix = 'Bearer ') {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.authHeader = authHeader;
    this.authPrefix = authPrefix;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (json) h['content-type'] = 'application/json';
    if (this.apiKey) h[this.authHeader] = `${this.authPrefix}${this.apiKey}`;
    return h;
  }

  private async call(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<FacilitatorAnswer> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string }).name;
      throw new FacilitatorUnreachable(name === 'TimeoutError' || name === 'AbortError', `facilitator ${path}: ${name ?? 'error'}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      const name = (e as { name?: string }).name;
      throw new FacilitatorUnreachable(name === 'TimeoutError' || name === 'AbortError', `facilitator ${path}: body ${name ?? 'error'}`);
    }
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    const ra = res.headers.get('retry-after');
    return { status: res.status, body: parsed, retryAfter: ra !== null && /^\d+$/.test(ra) ? Number(ra) : null };
  }

  verify(req: FacilitatorRequest, timeoutMs: number): Promise<FacilitatorAnswer> {
    return this.call('POST', '/verify', req, timeoutMs);
  }

  settle(req: FacilitatorRequest, timeoutMs: number): Promise<FacilitatorAnswer> {
    return this.call('POST', '/settle', req, timeoutMs);
  }

  supported(timeoutMs: number): Promise<FacilitatorAnswer> {
    return this.call('GET', '/supported', undefined, timeoutMs);
  }
}
