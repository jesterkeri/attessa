import { connect } from 'node:net';
import { jcs } from '@attessa/core';
import { FrameReader, encodeFrame } from './framing.ts';

/**
 * Client for the enclave's framed protocol (SPEC §4.2), reached through socat on 127.0.0.1:<5005|5007|5006>
 * (SPEC §5). One TCP connection per request: socat forks a vsock connection for each, and the enclave
 * serves each connection on its own thread.
 */

export class EnclaveUnreachable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EnclaveUnreachable';
  }
}

export interface ConfigureMsg {
  chainId: string;
  registry: string;
  agentId: string;
  origin: string;
  rpcAllowedChains: string[];
}

export type EnclaveReply = Record<string, unknown>;

export interface EnclaveTransport {
  request(msg: Record<string, unknown>, timeoutMs: number): Promise<EnclaveReply>;
}

/** Sends one JCS frame and reads one reply frame. Throws `EnclaveUnreachable` on any socket or protocol failure. */
export class TcpEnclaveTransport implements EnclaveTransport {
  private readonly port: number;
  private readonly host: string;
  constructor(port: number, host = '127.0.0.1') {
    this.port = port;
    this.host = host;
  }

  request(msg: Record<string, unknown>, timeoutMs: number): Promise<EnclaveReply> {
    const frame = encodeFrame(Buffer.from(jcs(msg), 'utf8'));
    return new Promise((resolve, reject) => {
      const sock = connect({ host: this.host, port: this.port });
      const reader = new FrameReader();
      let done = false;
      const finish = (err: Error | null, reply?: EnclaveReply) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.destroy();
        if (err) reject(err);
        else resolve(reply!);
      };
      const timer = setTimeout(() => {
        const e = new EnclaveUnreachable(`enclave did not answer within ${timeoutMs} ms`);
        e.name = 'TimeoutError';
        finish(e);
      }, timeoutMs);
      sock.on('connect', () => sock.write(frame));
      sock.on('data', (chunk) => {
        let frames: Buffer[];
        try {
          frames = reader.push(chunk);
        } catch (e) {
          finish(new EnclaveUnreachable('enclave sent a malformed frame', { cause: e }));
          return;
        }
        const first = frames[0];
        if (!first) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(first.toString('utf8'));
        } catch (e) {
          finish(new EnclaveUnreachable('enclave reply is not JSON', { cause: e }));
          return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          finish(new EnclaveUnreachable('enclave reply is not a JSON object'));
          return;
        }
        finish(null, parsed as EnclaveReply);
      });
      sock.on('error', (e) => finish(new EnclaveUnreachable(`enclave connection failed: ${e.message}`, { cause: e })));
      sock.on('close', () => finish(new EnclaveUnreachable('enclave closed the connection without a reply')));
    });
  }
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface Attestation {
  /** base64 of the COSE_Sign1 attestation document. */
  attestation: string;
  signer: string;
}

function asAttestation(r: EnclaveReply): Attestation | null {
  if (typeof r.attestation !== 'string' || !BASE64.test(r.attestation)) return null;
  if (typeof r.signer !== 'string' || !ADDRESS.test(r.signer)) return null;
  return { attestation: r.attestation, signer: r.signer };
}

export class EnclaveClient {
  readonly transport: EnclaveTransport;
  constructor(transport: EnclaveTransport) {
    this.transport = transport;
  }

  /** `configure` (SPEC §4.1 step 2). The enclave answers with its first attestation, or an error. */
  configure(cfg: ConfigureMsg, timeoutMs: number): Promise<EnclaveReply> {
    return this.transport.request({ type: 'configure', ...cfg }, timeoutMs);
  }

  attest(timeoutMs: number): Promise<EnclaveReply> {
    return this.transport.request({ type: 'attest' }, timeoutMs);
  }

  liveness(challenge: string, timeoutMs: number): Promise<EnclaveReply> {
    return this.transport.request({ type: 'liveness', challenge }, timeoutMs);
  }

  evaluate(
    msg: { requestId: string; method: string; path: string; body: string; paymentId: string; inputs: unknown },
    timeoutMs: number,
  ): Promise<EnclaveReply> {
    return this.transport.request({ type: 'evaluate', ...msg }, timeoutMs);
  }

  /**
   * Configures the enclave, or, when it was already configured this boot (a second `configure` answers
   * `bad_frame`, INV-22), fetches an attestation for the running key instead. Either way returns the
   * attestation and signer, and `configured: true` only when this call did the configuring.
   * A config mismatch with the running enclave isn't detectable here: the registry refuses the binding
   * at `registerSigner` (SPEC §3.4 step 6).
   */
  async configureOrAttest(cfg: ConfigureMsg, timeoutMs: number): Promise<Attestation & { configured: boolean }> {
    const first = await this.configure(cfg, timeoutMs);
    const att = asAttestation(first);
    if (att) return { ...att, configured: true };
    if (first.error !== 'bad_frame') throw new EnclaveUnreachable(`enclave refused configure: ${String(first.error)}`);
    const again = await this.attest(timeoutMs);
    const att2 = asAttestation(again);
    if (!att2) throw new EnclaveUnreachable(`enclave refused attest: ${String(again.error)}`);
    return { ...att2, configured: false };
  }
}

export function configureMessage(c: { chainId: number; registry: string; agentId: bigint | string; origin: string }): ConfigureMsg {
  return {
    chainId: String(c.chainId),
    registry: c.registry.toLowerCase(),
    agentId: String(c.agentId),
    origin: c.origin,
    rpcAllowedChains: [String(c.chainId)],
  };
}
