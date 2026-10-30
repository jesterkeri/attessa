import { randomBytes } from 'node:crypto';
import {
  PROOF_TTL,
  eip712Domain,
  inputsHash,
  jcs,
  livenessDigest,
  livenessToJson,
  proofDigest,
  proofToJson,
  requestHash,
  responseHash,
  type ExecutionProof,
} from '@attessa/core';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import type { GatewayConfig } from '../../src/config.ts';
import type { EvaluateRequest, EvaluateResult, SellerHost } from '../../src/sellerhost.ts';
import type { Clock, FakeChain } from './chain.ts';

export interface Tamper {
  /** Sign the proof with this key instead of the enclave's (a forged proof). */
  signWith?: Hex;
  proof?: (p: ExecutionProof) => ExecutionProof;
  /** Rewrites the inputs before the response is built and signed (the enclave signs what it was given). */
  inputs?: (i: Record<string, any>) => Record<string, any>;
  /** Read inputs at `head − blocksBack` instead of `head − 1`. */
  blocksBack?: number;
  /** Replace the response bytes after signing. */
  response?: (b: Buffer) => Buffer;
  /** Rewrites the 65-byte signature. */
  signature?: (sig: Hex) => Hex;
  /** Runs when evaluate starts (after the gateway's signer pre-check). */
  before?: () => void | Promise<void>;
  error?: string;
  unreachable?: boolean;
  delayMs?: number;
}

/**
 * Seller-host + enclave stand-in: a random in-test secp256k1 key, inputs read from the fake chain at
 * `latest − 1` (SPEC §5), the rules-v1 response JCS (SPEC §4.3), and a real EIP-712 ExecutionProof signed
 * through @attessa/core. `tamper` breaks one thing at a time.
 */
export class FakeSellerHost implements SellerHost {
  readonly key: Hex = generatePrivateKey();
  readonly signer: Address = privateKeyToAccount(this.key).address.toLowerCase() as Address;
  readonly releaseId: Hex = `0x${randomBytes(32).toString('hex')}`;
  tamper: Tamper = {};
  evaluateCalls = 0;
  lastRequest: EvaluateRequest | null = null;

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly chain: FakeChain,
    private readonly clock: Clock,
  ) {}

  async attest(): Promise<{ signer: Address }> {
    if (this.tamper.unreachable) throw new Error('ECONNREFUSED');
    return { signer: this.signer };
  }

  async liveness(challenge: Hex): Promise<unknown> {
    const l = { agentId: this.cfg.agentId, releaseId: this.releaseId, originHash: this.cfg.originHash, challenge, issuedAt: BigInt(this.clock.t) };
    const signature = await sign({ hash: livenessDigest(eip712Domain(BigInt(this.cfg.chainId), this.cfg.registry), l), privateKey: this.key, to: 'hex' });
    return { liveness: livenessToJson(l), signature };
  }

  async evaluate(req: EvaluateRequest, timeoutMs: number): Promise<EvaluateResult> {
    this.evaluateCalls++;
    this.lastRequest = req;
    const t = this.tamper;
    if (t.before) await t.before();
    if (t.delayMs) {
      if (t.delayMs >= timeoutMs) {
        await new Promise((r) => setTimeout(r, timeoutMs));
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      }
      await new Promise((r) => setTimeout(r, t.delayMs));
    }
    if (t.unreachable) throw new Error('ECONNREFUSED');
    if (t.error) return { ok: false, error: t.error };
    const body = Buffer.from(req.body, 'base64');
    const request = JSON.parse(body.toString('utf8')) as { payTo: Address; asset: Address; amount: string };
    const block = this.chain.blocks[this.chain.blocks.length - 1 - (t.blocksBack ?? 1)]!;
    const acct = await this.chain.accountAt(request.payTo, block.number);
    let inputs: Record<string, any> = {
      block: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString() },
      payTo: { address: request.payTo, code: acct.code, nonce: acct.nonce.toString(), balanceWei: acct.balance.toString() },
      source: 'forno',
    };
    if (t.inputs) inputs = t.inputs(inputs);
    const reasons: string[] = [];
    if (acct.code !== '0x') reasons.push('pay_to_is_contract');
    else if (acct.nonce === 0n) reasons.push('pay_to_never_sent');
    if (BigInt(request.amount) > 1_000_000_000n) reasons.push('large_amount');
    let response = Buffer.from(jcs({ verdict: reasons.length ? 'review' : 'allow', reasons, rulesVersion: '1', inputs }), 'utf8');
    const issuedAt = BigInt(this.clock.t);
    let proof: ExecutionProof = {
      agentId: this.cfg.agentId,
      releaseId: this.releaseId,
      requestId: req.requestId,
      requestHash: requestHash(req.method, req.path, body),
      responseHash: responseHash(response),
      inputsHash: inputsHash(inputs),
      paymentId: req.paymentId,
      issuedAt,
      expiresAt: issuedAt + PROOF_TTL,
    };
    if (t.proof) proof = t.proof(proof);
    const digest = proofDigest(eip712Domain(BigInt(this.cfg.chainId), this.cfg.registry), proof);
    let signature = await sign({ hash: digest, privateKey: t.signWith ?? this.key, to: 'hex' });
    if (t.signature) signature = t.signature(signature);
    if (t.response) response = t.response(response);
    return { ok: true, response: response.toString('base64'), proof: proofToJson(proof), signature };
  }
}
