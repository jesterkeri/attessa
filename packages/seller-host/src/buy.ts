import { isAddress, type LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { x402 } from '@celo/buy-core';
import { parseBatchReply, type BuySource, type RpcCall } from './inputs.ts';

/**
 * The buy RPC capability as a `BuySource` (SPEC §5, FR-11), paid through the library route of @celo/buy-core 0.8.5
 * (`x402.payingFetch`), not the `buy` CLI: on a headless mainnet host the CLI has no usable keystore. The signer is
 * `privateKeyToAccount(AGENT_PRIVATE_KEY)`, held in memory only; the key never reaches a log, an error, a config or
 * a child process.
 *
 * Not confirmed against a real paid call yet (T27): the capability id, the price, whether the capability accepts a
 * JSON-RPC batch. A reply that is not a valid batch array is a failed read.
 */

/** Largest per-call maximum the configuration may set (0.10 USDC): catches a units mistake before it can spend. */
export const MAX_AMOUNT_CEILING_ATOMIC = 100_000n;

export interface BuyConfig {
  /** The `inputs.source` suffix: `buy:<capabilityId>`. */
  capabilityId: string;
  /** The capability's endpoint (POST, JSON-RPC). */
  url: string;
  /** Per-call maximum in atomic USDC (6 decimals): refused before signing if the 402 asks for more; also what one evaluate is counted as. */
  maxAmountAtomic: bigint;
}

/** The enclave's source grammar (enclave/src/rules.rs `is_source`): `buy:` + `[A-Za-z0-9._:/-]+`. */
export const CAPABILITY_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

/** Atomic USDC as the decimal string `--max-amount` expects. */
export function atomicToDecimal(v: bigint): string {
  const s = v.toString().padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

export function validateBuyConfig(c: BuyConfig): void {
  if (typeof c.capabilityId !== 'string' || !CAPABILITY_ID.test(c.capabilityId)) throw new Error('buy: capabilityId must be 1-128 characters of A-Z a-z 0-9 . _ : / -');
  if (typeof c.url !== 'string') throw new Error('buy: url is required');
  let u: URL;
  try {
    u = new URL(c.url);
  } catch {
    throw new Error('buy: url is not a URL');
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') throw new Error('buy: url must be https without credentials');
  if (c.maxAmountAtomic <= 0n) throw new Error('buy: maxAmount must be positive');
  if (c.maxAmountAtomic > MAX_AMOUNT_CEILING_ATOMIC) throw new Error(`buy: maxAmount is above the ceiling of ${atomicToDecimal(MAX_AMOUNT_CEILING_ATOMIC)} USDC`);
}


/** The only chain and asset the agent wallet pays on: Celo mainnet USDC (SPEC §5). Anything else in a 402 is refused before signing. */
export const PAY_NETWORK = 'celo';
export const PAY_CHAIN_ID = 42220;
export const PAY_ASSET = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';

const KEY_SHAPE = /^(0x)?[0-9a-fA-F]{64}$/;

export type AgentKey = { ok: true; account: LocalAccount } | { ok: false; reason: string };

/**
 * The signer from env `AGENT_PRIVATE_KEY` (SPEC §5), in memory only. The result never contains the value: a missing or
 * malformed key gives a reason that names the problem, not the input, and the buy source is then not built.
 */
export function loadAgentAccount(env: NodeJS.ProcessEnv = process.env): AgentKey {
  const raw = env.AGENT_PRIVATE_KEY;
  if (raw === undefined || raw.trim() === '') return { ok: false, reason: 'AGENT_PRIVATE_KEY is not set' };
  const k = raw.trim();
  if (!KEY_SHAPE.test(k)) return { ok: false, reason: 'AGENT_PRIVATE_KEY is not 32 bytes of hex' };
  try {
    return { ok: true, account: privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as `0x${string}`) };
  } catch {
    return { ok: false, reason: 'AGENT_PRIVATE_KEY is not a valid secp256k1 key' };
  }
}

/** A 402 whose chosen requirement is not Celo mainnet USDC, `exact`, with an integer price within the cap. Thrown before signing. */
class RefusedRequirement extends Error {
  readonly code = 'refused_requirement';
}

/** Largest reply body read (1 MiB). */
const MAX_BODY = 1 << 20;

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY) {
      void reader.cancel().catch(() => {});
      throw Object.assign(new Error('too much output'), { code: 'too_large' });
    }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

/** A short machine code for a failure, never its message: library and network messages could carry request detail. */
function failureCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[a-z0-9_]{1,40}$/i.test(code)) return code;
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return 'aborted';
  return 'error';
}

/** What one paid read leaves behind as proof of payment. Public values only: the signature is never included. */
export interface BuyReceipt {
  capabilityId: string;
  url: string;
  network: string;
  asset: string;
  amount: string;
  status: number;
  outcome: string;
  /** Settlement transaction, when the service returned one. Otherwise `from` and `nonce` find it on the token. */
  txHash: string | null;
  from: string;
  nonce: string;
  timestamp: string;
}

export class BuyPaidSource implements BuySource {
  readonly id: string;
  readonly costPerEvaluate: bigint;
  private readonly c: BuyConfig;
  private readonly account: LocalAccount;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly onReceipt: ((r: BuyReceipt) => void | Promise<void>) | undefined;
  constructor(c: BuyConfig, account: LocalAccount, fetchImpl?: typeof fetch, onReceipt?: (r: BuyReceipt) => void | Promise<void>) {
    this.onReceipt = onReceipt;
    validateBuyConfig(c);
    this.c = c;
    this.id = `buy:${c.capabilityId}`;
    this.costPerEvaluate = c.maxAmountAtomic;
    this.account = account;
    this.fetchImpl = fetchImpl;
  }

  /** Nothing about the account or the config crosses a JSON or inspect boundary. */
  toJSON(): { id: string } {
    return { id: this.id };
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `BuyPaidSource(${this.id})`;
  }

  /**
   * One paid request per call, never repeated: payingFetch signs and sends the payment once (no retry after a payment
   * is on the wire; only the unpaid probe may be retried). The chosen requirement is checked before anything is signed,
   * and an abort before the send stops it. The abort signal also ends the request in flight. Errors carry a code only.
   */
  async batch(calls: RpcCall[], signal: AbortSignal): Promise<unknown[]> {
    if (signal.aborted) throw new Error(`${this.id}: paid read failed (aborted)`);
    const max = this.c.maxAmountAtomic;
    let text: string;
    try {
      const res = await x402.payingFetch(
        { account: this.account, network: PAY_NETWORK, preferredToken: 'USDC', ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) },
        this.c.url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(calls.map((x, i) => ({ jsonrpc: '2.0', id: i + 1, method: x.method, params: x.params }))),
          signal,
          // A redirect must never carry a signed payment to another origin.
          redirect: 'error',
          maxAmount: max,
          maxRetries: 1,
          onChallenge: (req) => {
            // Runs before the signer is touched. The library already refuses a price above `maxAmount`; this is the
            // check that the code here relies on, and it also pins chain, asset and scheme.
            if (req.network !== PAY_NETWORK) throw new RefusedRequirement('network');
            if (typeof req.asset !== 'string' || req.asset.toLowerCase() !== PAY_ASSET.toLowerCase()) throw new RefusedRequirement('asset');
            if (req.scheme !== 'exact') throw new RefusedRequirement('scheme');
            if (typeof req.maxAmountRequired !== 'string' || !/^[0-9]+$/.test(req.maxAmountRequired) || BigInt(req.maxAmountRequired) > max) throw new RefusedRequirement('price');
            if (typeof req.payTo !== 'string' || !isAddress(req.payTo)) throw new RefusedRequirement('payTo');
          },
          onBeforePayment: () => {
            if (signal.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
          },
          // Proof of payment: the library calls this after the paid request, whatever its outcome. A failed write can't
          // undo a payment and must not read as a failed call, so errors stop here (the library also guards this).
          onPayment: async (info) => {
            await this.onReceipt?.({ capabilityId: this.c.capabilityId, url: info.url, network: info.network, asset: info.asset, amount: info.amount, status: info.status, outcome: info.outcome, txHash: info.txHash ?? null, from: info.authorization.from, nonce: info.authorization.nonce, timestamp: info.timestamp });
          },
          onAccountingError: () => {},
        },
      );
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw Object.assign(new Error('status'), { code: `http_${res.status}` });
      }
      text = await readCapped(res);
    } catch (e) {
      throw new Error(`${this.id}: paid read failed (${failureCode(e)})`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${this.id}: reply is not JSON`);
    }
    return parseBatchReply(this.id, calls, json);
  }
}
