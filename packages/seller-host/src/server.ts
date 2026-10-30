import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeBase64Strict } from '@attessa/core';
import { parseRequestBody } from './body.ts';
import { EnclaveClient, configureMessage, type EnclaveReply } from './enclave.ts';
import { InputsUnavailable, type InputFetcher } from './inputs.ts';

/**
 * Seller-host HTTP on 127.0.0.1:7070 (mainnet) / 7071 (Sepolia), SPEC §5. Only the gateway calls it.
 *
 * | Route | Behaviour |
 * | `POST /internal/evaluate` | validate body schema (§4.3) → fetch inputs → enclave `evaluate` |
 * | `POST /internal/liveness` | enclave `liveness` |
 * | `POST /internal/attest`   | enclave `attest` |
 *
 * Replies pass the enclave's JSON through. Errors are `{"error":"<code>"}`: `bad_request` (400) for a body
 * that breaks §4.3, `bad_frame` (400) for a malformed envelope, `inputs_unavailable` (503), and
 * `enclave_unavailable` (503) when the enclave can't be reached; enclave errors keep their code.
 */

export interface SellerHostConfig {
  chainId: number;
  registry: string;
  agentId: bigint;
  /** Normalised origin (SPEC §2.1). */
  origin: string;
}

export interface SellerHostOptions {
  config: SellerHostConfig;
  enclave: EnclaveClient;
  inputs: InputFetcher;
  enclaveTimeoutMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

const MAX_HTTP_BODY = 65_536;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const METHOD = /^[A-Z]{1,16}$/;
const EVALUATE_KEYS = ['body', 'method', 'path', 'paymentId', 'requestId'];

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function send(res: ServerResponse, status: number, json: unknown): void {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_HTTP_BODY) throw new HttpError(413, 'bad_frame');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_frame');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'bad_frame');
  return v as Record<string, unknown>;
}

/** HTTP status for an enclave `{error}` reply. */
function errorStatus(code: string): number {
  if (code === 'bad_request' || code === 'bad_frame') return 400;
  return 503;
}

export class SellerHost {
  readonly server: Server;
  private readonly timeoutMs: number;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;

  private readonly o: SellerHostOptions;

  constructor(o: SellerHostOptions) {
    this.o = o;
    this.timeoutMs = o.enclaveTimeoutMs ?? 5_000;
    this.log = o.log ?? (() => {});
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        if (e instanceof HttpError) return send(res, e.status, { error: e.code });
        this.log('internal_error', { reason: (e as Error).message });
        send(res, 500, { error: 'internal_error' });
      });
    });
  }

  listen(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve((this.server.address() as AddressInfo).port));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /**
   * Boot step: `configure` the enclave from this host's config (SPEC §4.1 step 2), or attest if it was
   * already configured this boot. Retries until the enclave answers.
   */
  async configureEnclave(opts: { retryMs?: number; maxAttempts?: number } = {}): Promise<{ signer: string; configured: boolean }> {
    const retryMs = opts.retryMs ?? 2_000;
    const max = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
    for (let i = 1; ; i++) {
      try {
        const r = await this.o.enclave.configureOrAttest(configureMessage(this.o.config), this.timeoutMs);
        this.log(r.configured ? 'enclave_configured' : 'enclave_already_configured', { signer: r.signer });
        return { signer: r.signer, configured: r.configured };
      } catch (e) {
        this.log('enclave_configure_failed', { attempt: i, reason: (e as Error).message });
        if (i >= max) throw e;
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    const body = await readJson(req);
    switch (req.url) {
      case '/internal/evaluate':
        return this.reply(res, await this.evaluate(body));
      case '/internal/liveness':
        return this.reply(res, await this.liveness(body));
      case '/internal/attest':
        return this.reply(res, await this.attest(body));
      default:
        return send(res, 404, { error: 'not_found' });
    }
  }

  private reply(res: ServerResponse, r: EnclaveReply): void {
    if (typeof r.error === 'string') return send(res, errorStatus(r.error), { error: r.error });
    send(res, 200, r);
  }

  private async callEnclave(fn: () => Promise<EnclaveReply>): Promise<EnclaveReply> {
    try {
      return await fn();
    } catch (e) {
      this.log('enclave_unreachable', { reason: (e as Error).message });
      return { error: 'enclave_unavailable' };
    }
  }

  private async attest(body: Record<string, unknown>): Promise<EnclaveReply> {
    if (Object.keys(body).length !== 0) return { error: 'bad_frame' };
    return this.callEnclave(() => this.o.enclave.attest(this.timeoutMs));
  }

  private async liveness(body: Record<string, unknown>): Promise<EnclaveReply> {
    const keys = Object.keys(body);
    if (keys.length !== 1 || typeof body.challenge !== 'string' || !BYTES32.test(body.challenge)) return { error: 'bad_frame' };
    const challenge = body.challenge;
    return this.callEnclave(() => this.o.enclave.liveness(challenge, this.timeoutMs));
  }

  private async evaluate(b: Record<string, unknown>): Promise<EnclaveReply> {
    const keys = Object.keys(b).sort();
    if (keys.length !== EVALUATE_KEYS.length || keys.some((k, i) => k !== EVALUATE_KEYS[i])) return { error: 'bad_frame' };
    const { requestId, method, path, body, paymentId } = b;
    if (typeof requestId !== 'string' || !BYTES32.test(requestId)) return { error: 'bad_frame' };
    if (typeof paymentId !== 'string' || !BYTES32.test(paymentId)) return { error: 'bad_frame' };
    if (typeof method !== 'string' || !METHOD.test(method)) return { error: 'bad_frame' };
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || path.length > 2048) return { error: 'bad_frame' };
    if (typeof body !== 'string') return { error: 'bad_frame' };
    const bytes = decodeBase64Strict(body);
    if (!bytes) return { error: 'bad_frame' };
    const request = parseRequestBody(bytes, this.o.config.chainId);
    if (!request) return { error: 'bad_request' };
    let inputs;
    try {
      inputs = await this.o.inputs.fetch(request.payTo);
    } catch (e) {
      if (e instanceof InputsUnavailable) return { error: 'inputs_unavailable' };
      throw e;
    }
    return this.callEnclave(() =>
      this.o.enclave.evaluate({ requestId, method, path, body, paymentId, inputs }, this.timeoutMs),
    );
  }
}
