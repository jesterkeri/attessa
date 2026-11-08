import { execFile } from 'node:child_process';
import { parseBatchReply, type BuySource, type RpcCall } from './inputs.ts';

/**
 * The buy RPC capability as a `BuySource` (SPEC §5, FR-11), driven through the installed `buy` CLI
 * (@celo/buy 0.8.5, subcommand `curl` with `--max-amount`, `--request POST` and a body). buy pays from its
 * own account, so this code never reads, holds or passes the agent key: the account is set up once by an
 * operator (`buy setup --import`, stdin from the 0600 file, never argv).
 *
 * Not confirmed against a real paid call yet (T27): the capability id, the price, whether the capability
 * accepts a JSON-RPC batch, and what stdout holds. A reply that is not a valid batch array is a failed read.
 */

/** Largest per-call maximum the configuration may set (0.10 USDC): catches a units mistake before it can spend. */
export const MAX_AMOUNT_CEILING_ATOMIC = 100_000n;

export interface BuyConfig {
  /** The `inputs.source` suffix: `buy:<capabilityId>`. */
  capabilityId: string;
  /** The capability's endpoint (POST, JSON-RPC). */
  url: string;
  /** Per-call maximum in atomic USDC (6 decimals). Passed to buy as `--max-amount`; also what one evaluate is counted as. */
  maxAmountAtomic: bigint;
  /** Path of the `buy` binary. Default `buy`, found on PATH. */
  binary?: string;
  /** buy account name (`buy --account`). Default: buy's default account. */
  account?: string;
  /** buy's state directory (BUY_HOME). */
  home?: string;
}

/** Atomic USDC as the decimal string `--max-amount` expects. */
export function atomicToDecimal(v: bigint): string {
  const s = v.toString().padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

export function validateBuyConfig(c: BuyConfig): void {
  if (!/^[\x21-\x7e]{1,128}$/.test(c.capabilityId)) throw new Error('buy: capabilityId must be 1-128 visible ASCII characters');
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

export type Exec = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; signal: AbortSignal; maxBuffer: number }) => Promise<{ stdout: string }>;

const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    // stdin is closed so buy can't wait on it; stderr is captured and dropped, never surfaced.
    const child = execFile(file, args, { ...opts, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve({ stdout })));
    child.stdin?.end();
  });

export class BuyCliSource implements BuySource {
  readonly id: string;
  readonly costPerEvaluate: bigint;
  private readonly c: BuyConfig;
  private readonly exec: Exec;
  private readonly env: NodeJS.ProcessEnv;
  constructor(c: BuyConfig, exec: Exec = defaultExec, parentEnv: NodeJS.ProcessEnv = process.env) {
    validateBuyConfig(c);
    this.c = c;
    this.id = `buy:${c.capabilityId}`;
    this.costPerEvaluate = c.maxAmountAtomic;
    this.exec = exec;
    // A minimal environment: AGENT_PRIVATE_KEY and any other secret in ours never reach the child.
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'HOME', 'LANG']) if (parentEnv[k] !== undefined) env[k] = parentEnv[k];
    if (c.home !== undefined) env.BUY_HOME = c.home;
    this.env = env;
  }

  /** Argv for one paid batch. Only public values: the batch, the URL, the cap and the account name. */
  args(calls: RpcCall[]): string[] {
    const body = JSON.stringify(calls.map((x, i) => ({ jsonrpc: '2.0', id: i + 1, method: x.method, params: x.params })));
    return [
      ...(this.c.account !== undefined ? ['--account', this.c.account] : []),
      'curl',
      '--max-amount',
      atomicToDecimal(this.c.maxAmountAtomic),
      '--silent',
      '--request',
      'POST',
      '--header',
      'content-type: application/json',
      '--data',
      body,
      this.c.url,
    ];
  }

  /** One attempt, no retry: a failed paid call is never repeated here. Errors carry no buy output. */
  async batch(calls: RpcCall[], signal: AbortSignal): Promise<unknown[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.exec(this.c.binary ?? 'buy', this.args(calls), { env: this.env, signal, maxBuffer: 1 << 20 }));
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      throw new Error(`${this.id}: buy failed${typeof code === 'number' || typeof code === 'string' ? ` (${String(code)})` : ''}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new Error(`${this.id}: reply is not JSON`);
    }
    return parseBatchReply(this.id, calls, json);
  }
}
