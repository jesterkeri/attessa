import { spawn } from 'node:child_process';
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
  /**
   * Where buy keeps the account key (BUY_KEYSTORE_BACKEND). buy defaults to `system`, the OS keychain, which a
   * headless host does not have. @celo/buy-keystore 0.8.5 has no passphrase: `file` is a plaintext 0600 file under
   * BUY_HOME and refuses mainnet accounts. Not a secret; forwarded to the child as-is.
   */
  keystoreBackend?: 'system' | 'file';
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
  if (c.keystoreBackend !== undefined && c.keystoreBackend !== 'system' && c.keystoreBackend !== 'file') throw new Error('buy: keystoreBackend must be system or file');
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

/**
 * Runs buy in its own process group (Linux) so that an abort ends buy and the curl it spawned: buy hands the signed
 * payment to a curl grandchild, which would otherwise finish after the timeout. stdin is closed, stderr is dropped
 * and never surfaced, stdout is capped.
 */
export const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const group = process.platform !== 'win32';
    const child = spawn(file, args, { env: opts.env, stdio: ['ignore', 'pipe', 'ignore'], detached: group });
    const killGroup = (): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    let out = '';
    let done = false;
    const finish = (f: () => void): void => {
      if (done) return;
      done = true;
      opts.signal.removeEventListener('abort', onAbort);
      killGroup();
      f();
    };
    const onAbort = (): void => finish(() => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })));
    if (opts.signal.aborted) return onAbort();
    opts.signal.addEventListener('abort', onAbort);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
      if (out.length > opts.maxBuffer) finish(() => reject(Object.assign(new Error('too much output'), { code: 'MAXBUFFER' })));
    });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => finish(() => (code === 0 ? resolve({ stdout: out }) : reject(Object.assign(new Error('buy exited'), { code: code ?? 'SIGNAL' })))));
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
    // XDG_RUNTIME_DIR and the session bus address are what the OS keychain (backend `system`) needs; none is secret.
    for (const k of ['PATH', 'HOME', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (parentEnv[k] !== undefined) env[k] = parentEnv[k];
    if (c.home !== undefined) env.BUY_HOME = c.home;
    // The config field wins; otherwise our own BUY_KEYSTORE_BACKEND, if it is one buy accepts. Nothing else of buy's env is forwarded.
    const backend = c.keystoreBackend ?? parentEnv.BUY_KEYSTORE_BACKEND;
    if (backend === 'system' || backend === 'file') env.BUY_KEYSTORE_BACKEND = backend;
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
