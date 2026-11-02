import type { BuySpendGuard } from './guard.ts';

/**
 * SPEC §5 input fetch: block N = latest − 1, then `{number, hash, timestamp}` of N and `eth_getCode`,
 * `eth_getTransactionCount`, `eth_getBalance` of payTo at N, as one JSON-RPC batch. Primary is the buy
 * Celo RPC capability (S7) while the budget guard allows it; the fallback is Forno (`source:"forno"`).
 * Each attempt has a 5 s timeout; after the primary fails, one fallback attempt, then `inputs_unavailable`.
 */

export interface RpcCall {
  method: string;
  params: unknown[];
}

export interface RpcSource {
  /** The `inputs.source` value: `forno` or `buy:<capability-id>`. */
  readonly id: string;
  /** Results in call order. Throws on transport errors and on any per-call JSON-RPC error. */
  batch(calls: RpcCall[], signal: AbortSignal): Promise<unknown[]>;
}

/** A paid source. `costPerEvaluate` is atomic USDC (6 decimals) charged for one input fetch. */
export interface BuySource extends RpcSource {
  readonly costPerEvaluate: bigint;
}

export class InputsUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InputsUnavailable';
  }
}

/** Plain JSON-RPC over HTTP POST (Forno). Batches are sent as one JSON array. */
export class HttpRpcSource implements RpcSource {
  readonly id: string;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  constructor(id: string, url: string, fetchImpl: typeof fetch = fetch) {
    this.id = id;
    this.url = url;
    this.fetchImpl = fetchImpl;
  }

  async batch(calls: RpcCall[], signal: AbortSignal): Promise<unknown[]> {
    const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }));
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`${this.id}: HTTP ${res.status}`);
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) throw new Error(`${this.id}: batch reply is not an array`);
    const byId = new Map<unknown, Record<string, unknown>>();
    for (const r of json) {
      if (typeof r === 'object' && r !== null) byId.set((r as Record<string, unknown>).id, r as Record<string, unknown>);
    }
    return calls.map((c, i) => {
      const r = byId.get(i + 1);
      if (!r) throw new Error(`${this.id}: no reply for ${c.method}`);
      if (r.error !== undefined) throw new Error(`${this.id}: ${c.method} failed`);
      if (!('result' in r)) throw new Error(`${this.id}: ${c.method} has no result`);
      return r.result;
    });
  }
}

export interface Inputs {
  block: { number: string; hash: string; timestamp: string };
  payTo: { address: string; code: string; nonce: string; balanceWei: string };
  source: string;
}

const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const DATA = /^0x([0-9a-f]{2})*$/i;

function quantity(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !QUANTITY.test(v)) throw new Error(`bad ${what}`);
  return BigInt(v);
}

/** Reads the four inputs from one source at latest − 1. */
export async function readInputsFrom(source: RpcSource, payTo: string, timeoutMs: number): Promise<Inputs> {
  const signal = AbortSignal.timeout(timeoutMs);
  const [head] = await source.batch([{ method: 'eth_blockNumber', params: [] }], signal);
  const latest = quantity(head, 'eth_blockNumber');
  if (latest < 1n) throw new Error('chain has no block before latest');
  const n = latest - 1n;
  const tag = `0x${n.toString(16)}`;
  const [block, code, nonce, balance] = await source.batch(
    [
      { method: 'eth_getBlockByNumber', params: [tag, false] },
      { method: 'eth_getCode', params: [payTo, tag] },
      { method: 'eth_getTransactionCount', params: [payTo, tag] },
      { method: 'eth_getBalance', params: [payTo, tag] },
    ],
    signal,
  );
  if (typeof block !== 'object' || block === null) throw new Error('block not found');
  const b = block as Record<string, unknown>;
  if (quantity(b.number, 'block number') !== n) throw new Error('block number differs from the one requested');
  if (typeof b.hash !== 'string' || !HASH.test(b.hash)) throw new Error('bad block hash');
  const timestamp = quantity(b.timestamp, 'block timestamp');
  if (typeof code !== 'string' || !DATA.test(code)) throw new Error('bad code');
  return {
    block: { number: n.toString(), hash: b.hash.toLowerCase(), timestamp: timestamp.toString() },
    payTo: {
      address: payTo,
      code: code.toLowerCase(),
      nonce: quantity(nonce, 'nonce').toString(),
      balanceWei: quantity(balance, 'balance').toString(),
    },
    source: source.id,
  };
}

export interface InputFetcherOptions {
  forno: RpcSource;
  buy?: BuySource | null;
  guard?: BuySpendGuard | null;
  timeoutMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export class InputFetcher {
  private readonly timeoutMs: number;
  private readonly o: InputFetcherOptions;
  constructor(o: InputFetcherOptions) {
    this.o = o;
    this.timeoutMs = o.timeoutMs ?? 5_000;
  }

  /** Primary, then one fallback attempt on Forno, then `InputsUnavailable`. */
  async fetch(payTo: string, now: Date = new Date()): Promise<Inputs> {
    const { buy, guard, forno } = this.o;
    let primary: RpcSource = forno;
    if (buy) {
      if (!guard) throw new Error('a buy source needs the budget guard');
      if (guard.allow(buy.costPerEvaluate, now)) {
        primary = buy;
        // Counted before the call: a paid request is charged whether or not its answer is usable.
        guard.record(buy.costPerEvaluate, now);
      }
    }
    try {
      return await readInputsFrom(primary, payTo, this.timeoutMs);
    } catch (e) {
      this.o.log?.('inputs_primary_failed', { source: primary.id, reason: (e as Error).message });
    }
    try {
      return await readInputsFrom(forno, payTo, this.timeoutMs);
    } catch (e) {
      this.o.log?.('inputs_unavailable', { reason: (e as Error).message });
      throw new InputsUnavailable('inputs_unavailable', { cause: e });
    }
  }
}
