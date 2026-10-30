import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  DEPLOYMENTS,
  PROOF_TTL,
  eip712Domain,
  encodeUserData,
  inputsHash,
  jcs,
  livenessDigest,
  livenessToJson,
  normalizeOrigin,
  originHash,
  proofDigest,
  proofToJson,
  requestHash,
  responseHash,
} from '@attessa/core';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { FrameReader, encodeFrame } from '../src/framing.ts';

/**
 * In-process stand-in for the enclave app (SPEC §4): a TCP server speaking the §4.2 framing, one-shot
 * `configure` (INV-22), a random in-test secp256k1 key, and rules v1 (§4.3) signed through @attessa/core.
 * The attestation document is whatever `makeAttestation` returns (random bytes by default): there is no NSM here.
 */

export interface FakeEnclaveConfig {
  chainId: bigint;
  registry: Address;
  agentId: bigint;
  origin: string;
  originHash: Hex;
}

export interface FakeEnclaveOptions {
  /** Builds the attestation document for (user_data, public_key). */
  makeAttestation?: (userData: Hex, publicKey: Hex) => Uint8Array;
  clock?: () => number;
  /** Delay every reply (timeout tests). */
  delayMs?: number;
}

const BYTES32 = /^0x[0-9a-f]{64}$/;

function strictKeys(m: Record<string, unknown>, keys: string[]): boolean {
  const k = Object.keys(m).sort();
  const want = [...keys].sort();
  return k.length === want.length && k.every((x, i) => x === want[i]);
}

export class FakeEnclave {
  readonly key: Hex = generatePrivateKey();
  readonly signer: Address = privateKeyToAccount(this.key).address.toLowerCase() as Address;
  readonly publicKey: Hex = privateKeyToAccount(this.key).publicKey;
  readonly releaseId: Hex = `0x${randomBytes(32).toString('hex')}`;
  config: FakeEnclaveConfig | null = null;
  configureCount = 0;
  /** Every decoded request, in order. */
  readonly received: Array<Record<string, unknown>> = [];
  /** Raw request frames, to check the bytes are JCS. */
  readonly rawFrames: Buffer[] = [];
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;

  constructor(private readonly o: FakeEnclaveOptions = {}) {}

  async start(): Promise<number> {
    this.server = createServer((sock) => this.serve(sock));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private now(): bigint {
    return BigInt(this.o.clock ? this.o.clock() : Math.floor(Date.now() / 1000));
  }

  private serve(sock: Socket): void {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    const reader = new FrameReader();
    sock.on('data', async (chunk) => {
      let frames: Buffer[];
      try {
        frames = reader.push(chunk);
      } catch {
        sock.end(encodeFrame(Buffer.from('{"error":"bad_frame"}')));
        return;
      }
      for (const f of frames) {
        this.rawFrames.push(f);
        const reply = await this.handle(f);
        if (this.o.delayMs) await new Promise((r) => setTimeout(r, this.o.delayMs));
        if (!sock.destroyed) sock.write(encodeFrame(Buffer.from(jcs(reply), 'utf8')));
      }
    });
    sock.on('error', () => {});
  }

  private attestation(): Record<string, string> {
    const c = this.config!;
    const userData = encodeUserData({ chainId: c.chainId, registry: c.registry, agentId: c.agentId, originHash: c.originHash });
    const doc = this.o.makeAttestation ? this.o.makeAttestation(userData, this.publicKey) : randomBytes(64);
    return { attestation: Buffer.from(doc).toString('base64'), signer: this.signer };
  }

  async handle(frame: Buffer): Promise<Record<string, unknown>> {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(frame.toString('utf8')) as Record<string, unknown>;
    } catch {
      return { error: 'bad_frame' };
    }
    this.received.push(m);
    switch (m.type) {
      case 'configure': {
        if (this.config) return { error: 'bad_frame' };
        if (!strictKeys(m, ['type', 'chainId', 'registry', 'agentId', 'origin', 'rpcAllowedChains'])) return { error: 'bad_frame' };
        let origin: string;
        try {
          origin = normalizeOrigin(String(m.origin), { local: true });
        } catch {
          return { error: 'bad_frame' };
        }
        this.configureCount++;
        this.config = {
          chainId: BigInt(String(m.chainId)),
          registry: String(m.registry) as Address,
          agentId: BigInt(String(m.agentId)),
          origin,
          originHash: originHash(origin),
        };
        return this.attestation();
      }
      case 'attest':
        if (!this.config) return { error: 'not_configured' };
        if (!strictKeys(m, ['type'])) return { error: 'bad_frame' };
        return this.attestation();
      case 'liveness': {
        if (!this.config) return { error: 'not_configured' };
        if (!strictKeys(m, ['type', 'challenge']) || typeof m.challenge !== 'string' || !BYTES32.test(m.challenge)) return { error: 'bad_frame' };
        const c = this.config;
        const l = { agentId: c.agentId, releaseId: this.releaseId, originHash: c.originHash, challenge: m.challenge as Hex, issuedAt: this.now() };
        const signature = await sign({ hash: livenessDigest(eip712Domain(c.chainId, c.registry), l), privateKey: this.key, to: 'hex' });
        return { liveness: livenessToJson(l), signature };
      }
      case 'evaluate':
        return this.evaluate(m);
      default:
        return { error: 'bad_frame' };
    }
  }

  private async evaluate(m: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.config) return { error: 'not_configured' };
    const c = this.config;
    if (!strictKeys(m, ['type', 'requestId', 'method', 'path', 'body', 'paymentId', 'inputs'])) return { error: 'bad_frame' };
    const { requestId, method, path, body, paymentId, inputs } = m as Record<string, any>;
    if (!BYTES32.test(requestId) || !BYTES32.test(paymentId) || /^0x0+$/.test(paymentId)) return { error: 'bad_frame' };
    const bytes = Buffer.from(String(body), 'base64');
    let req: Record<string, string>;
    try {
      req = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { error: 'bad_request' };
    }
    if (req.chainId !== c.chainId.toString()) return { error: 'bad_request' };
    if (typeof inputs !== 'object' || inputs === null || inputs.payTo?.address !== req.payTo) return { error: 'bad_inputs' };
    const pinned = Object.values(DEPLOYMENTS)
      .filter((d) => BigInt(d.chainId) === c.chainId)
      .flatMap((d) => Object.values(d.assets).map((a) => a!.address.toLowerCase()));
    const deny: string[] = [];
    const review: string[] = [];
    if (!pinned.includes(req.asset!)) deny.push('unknown_asset');
    if (inputs.payTo.code !== '0x') review.push('pay_to_is_contract');
    if (inputs.payTo.code === '0x' && inputs.payTo.nonce === '0') review.push('pay_to_never_sent');
    if (BigInt(req.amount!) > 1_000_000_000n) review.push('large_amount');
    const verdict = deny.length ? 'deny' : review.length ? 'review' : 'allow';
    const response = Buffer.from(jcs({ verdict, reasons: [...deny, ...review], rulesVersion: '1', inputs }), 'utf8');
    const issuedAt = this.now();
    const proof = {
      agentId: c.agentId,
      releaseId: this.releaseId,
      requestId: requestId as Hex,
      requestHash: requestHash(method, path, bytes),
      responseHash: responseHash(response),
      inputsHash: inputsHash(inputs),
      paymentId: paymentId as Hex,
      issuedAt,
      expiresAt: issuedAt + PROOF_TTL,
    };
    const signature = await sign({ hash: proofDigest(eip712Domain(c.chainId, c.registry), proof), privateKey: this.key, to: 'hex' });
    return { response: response.toString('base64'), proof: proofToJson(proof), signature };
  }
}
