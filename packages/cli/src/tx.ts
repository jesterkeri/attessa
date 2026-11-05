import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
} from 'viem';
import { canPayGas, gasTerms, isInsufficientFundsReply } from '@attessa/sdk';
import { CERT_MANAGER_ABI, REGISTRY_ABI } from './abi.ts';
import type { Chain, Deps, Global } from './context.ts';
import { CliError, ERR } from './copy.ts';
import { RpcError, RpcUnavailable, revertData } from './rpc.ts';

/** Contract reads and writes. Writes are planned and simulated with `eth_call`; only `send` broadcasts. */

/** EIP-7825 per-transaction gas cap; every registry function stays below it (SPEC §3.4, C1.1). Shared with the SDK. */
export { TX_GAS_CAP } from '@attessa/sdk';

/**
 * The seller-side FLOWS §8 "rpc unavailable" row for a chain read made before anything is signed: a dropped
 * connection, or a JSON-RPC error reply that isn't a contract revert (a rate limit, an internal error). A revert is
 * the contract's own answer, so it stays an RpcError for the caller (`ownerOf` reads it as unknown_agent). The
 * reply's text is never printed. Anything else passes through unchanged.
 */
export function rpcRow(url: string, e: unknown): unknown {
  if (e instanceof RpcUnavailable || (e instanceof RpcError && !isRevert(e))) return ERR.rpcUnavailable(url);
  return e;
}

function isRevert(e: RpcError): boolean {
  return e.code === 3 || revertData(e) !== null || /revert/i.test(e.message);
}


/** One chain read, before anything is signed, with `rpcRow`'s mapping. */
async function chainRead<T>(c: Chain, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    throw rpcRow(c.url, e);
  }
}

export async function read<const abi extends Abi, fn extends ContractFunctionName<abi, 'view'>>(
  c: Chain,
  to: Address,
  abi: abi,
  functionName: fn,
  args: ContractFunctionArgs<abi, 'view', fn>,
): Promise<any> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const out = await chainRead(c, () => c.rpc.request('eth_call', [{ to, data }, 'latest']));
  return decodeFunctionResult({ abi, functionName, data: out as Hex } as never);
}

export interface Head {
  number: bigint;
  timestamp: bigint;
}

export async function head(c: Chain): Promise<Head> {
  const b = (await chainRead(c, () => c.rpc.request('eth_getBlockByNumber', ['latest', false]))) as { number: string; timestamp: string };
  return { number: BigInt(b.number), timestamp: BigInt(b.timestamp) };
}

export interface Step {
  /** What this transaction does, for the plan and for `gas_too_low`. */
  label: string;
  to: Address;
  data: Hex;
}

export interface Revert {
  name: string;
  args: readonly unknown[];
}

const ALL_ERRORS = [...REGISTRY_ABI, ...CERT_MANAGER_ABI] as Abi;

/** The custom error (or `Error(string)`) a reverting call returned, or null when the node gave no data. */
export function decodeRevert(e: unknown): Revert | null {
  const data = revertData(e);
  if (!data || data === '0x') return null;
  try {
    const d = decodeErrorResult({ abi: ALL_ERRORS, data });
    return { name: d.errorName, args: (d.args ?? []) as readonly unknown[] };
  } catch {
    return { name: 'unknown', args: [data] };
  }
}

export type Simulation = { ok: true; gas: bigint } | { ok: false; revert: Revert | null; message: string };

/**
 * `eth_call` then `eth_estimateGas`, from `from`, at latest. Never sends anything. Both are chain reads with
 * `rpcRow`'s mapping, so a dropped connection or a non-revert error reply (a rate limit, an internal error) is the
 * rpc_unavailable row; only a revert comes back as `ok: false`. `message` is the node's reply text: it is never
 * printed (`revertToError` prints only names and reasons decoded from the ABI).
 */
export async function simulate(c: Chain, from: Address, step: Step): Promise<Simulation> {
  const tx = { from, to: step.to, data: step.data };
  try {
    await chainRead(c, () => c.rpc.request('eth_call', [tx, 'latest']));
    const gas = BigInt((await chainRead(c, () => c.rpc.request('eth_estimateGas', [tx]))) as string);
    return { ok: true, gas };
  } catch (e) {
    if (e instanceof RpcError) return { ok: false, revert: decodeRevert(e), message: e.message };
    throw e;
  }
}

export async function gasPrice(c: Chain): Promise<bigint> {
  return BigInt((await chainRead(c, () => c.rpc.request('eth_gasPrice', []))) as string);
}

export interface Sent {
  hash: Hex;
  blockNumber: bigint;
  logs: Array<{ address: Address; topics: Hex[]; data: Hex }>;
}

/**
 * Signs `step` with the env key and broadcasts it, then waits for the receipt. Runs only when the user ran
 * a write command with `ATTESSA_PRIVATE_KEY` set, without `--dry-run`, and confirmed (or passed `--yes`).
 * Re-simulates first, so a step planned before an earlier one landed is checked against the new state.
 */
export async function send(c: Chain, deps: Deps, step: Step, onRevert: (r: Revert | null, message: string) => CliError): Promise<Sent> {
  const account = c.account;
  if (!account) throw new Error('send: no account');
  const sim = await simulate(c, account.address, step);
  if (!sim.ok) throw onRevert(sim.revert, sim.message);
  const [nonceHex, price, tip, balance] = await Promise.all([
    chainRead(c, () => c.rpc.request('eth_getTransactionCount', [account.address, 'pending'])),
    gasPrice(c),
    chainRead(c, () => c.rpc.request('eth_maxPriorityFeePerGas', [])).then((v) => BigInt(v as string)),
    chainRead(c, () => c.rpc.request('eth_getBalance', [account.address, 'latest'])).then((v) => BigInt(v as string)),
  ]);
  // The shared gas terms and funds rule (@attessa/sdk gas.ts): refused before signing when the balance can't
  // cover gas x maxFeePerGas; eth_call and eth_estimateGas above carry no fee fields, so they never check it.
  const t = gasTerms(sim.gas, price, tip);
  const noFunds = (tail: 'Nothing was signed.' | 'Nothing was sent.') =>
    ERR.insufficientGasFunds(account.address.toLowerCase(), step.label, t.maxCost, c.chainId, tail);
  if (!canPayGas(balance, t)) throw noFunds('Nothing was signed.');
  const raw = await account.signTransaction({
    type: 'eip1559',
    chainId: c.chainId,
    nonce: Number(BigInt(nonceHex as string)),
    to: step.to,
    data: step.data,
    value: 0n,
    gas: t.gas,
    maxFeePerGas: t.maxFeePerGas,
    maxPriorityFeePerGas: t.maxPriorityFeePerGas,
  });
  // From the broadcast on, the transaction may land even if a reply is lost, so a dropped RPC is the sent-unconfirmed
  // row with the hash (from the signed bytes), never the rpc row and never the unexpected-error line.
  const hash = keccak256(raw);
  const lost = () => ERR.sentUnconfirmed(step.label, hash, 'Check the tx on a Celo explorer before running again.');
  try {
    await c.rpc.request('eth_sendRawTransaction', [raw]);
  } catch (e) {
    // The balance moved since the read, or the node counts more (pending txs, an L1 fee). A refused broadcast never
    // entered the pool, so the signed bytes went nowhere: "Nothing was sent." The node's text is never printed.
    if (e instanceof RpcError && isInsufficientFundsReply(e.code, e.message)) throw noFunds('Nothing was sent.');
    if (e instanceof RpcUnavailable) throw lost();
    throw e;
  }
  for (let i = 0; i < 180; i++) {
    let r: { status: string; blockNumber: string; gasUsed: string; logs?: Array<{ address: Address; topics: Hex[]; data: Hex }> } | null;
    try {
      r = (await c.rpc.request('eth_getTransactionReceipt', [hash])) as typeof r;
    } catch (e) {
      if (e instanceof RpcUnavailable || e instanceof RpcError) throw lost();
      throw e;
    }
    if (r) {
      if (r.status !== '0x1') {
        if (BigInt(r.gasUsed) >= t.gas) throw ERR.gasTooLow(step.label);
        throw new CliError('tx_reverted', `The transaction reverted at ${step.label} (tx ${hash}). Nothing changed.`, 'Run the command again to see why.');
      }
      return { hash, blockNumber: BigInt(r.blockNumber), logs: (r.logs ?? []).map((l) => ({ ...l, address: l.address.toLowerCase() as Address })) };
    }
    await deps.sleep(1000);
  }
  throw new CliError('tx_unconfirmed', `No receipt for ${hash} after 3 minutes.`, 'Check the tx on a Celo explorer before running again.');
}

/**
 * Shared tail of every write command: print the plan and the simulation when not sending; otherwise
 * confirm and send each step in order. `lines` are already printed by the caller.
 */
export async function planOrSend(
  c: Chain,
  g: Global,
  deps: Deps,
  plan: { yesWord: string; steps: Step[]; from: Address; simulations: Array<Simulation | null> },
  onRevert: (r: Revert | null, message: string) => CliError,
  onSent: (index: number, sent: Sent) => Promise<void> | void,
): Promise<'sent' | 'planned'> {
  const { io } = deps;
  if (g.dryRun || !c.account) {
    plan.steps.forEach((s, i) => {
      const sim = plan.simulations[i];
      const simText = sim === null || sim === undefined ? 'simulated after the previous transaction lands' : sim.ok ? `eth_call ok, gas ${sim.gas}` : `eth_call reverts${sim.revert ? ` ${sim.revert.name}` : ''}`;
      io.out(`  (tx ${i + 1}/${plan.steps.length}: ${s.label}; from ${plan.from} to ${s.to}; ${simText})`);
      io.out(`  (calldata ${s.data})`);
    });
    io.out(g.dryRun ? '  (dry run: nothing was sent)' : '  (no ATTESSA_PRIVATE_KEY: nothing was sent; set it and run again to send these yourself)');
    return 'planned';
  }
  if (!g.yes && !(await io.confirm(plan.yesWord))) throw ERR.cancelled(plan.yesWord); // a non-TTY stdin answers no (bin.ts)
  for (let i = 0; i < plan.steps.length; i++) {
    let sent: Sent;
    try {
      sent = await send(c, deps, plan.steps[i]!, onRevert);
    } catch (e) {
      // Step 1's reads run before its signature; a later step's run after an earlier one was signed and sent.
      throw i === 0 ? e : afterSigning(e);
    }
    try {
      await onSent(i, sent);
    } catch (e) {
      throw afterSigning(e);
    }
  }
  return 'sent';
}

/**
 * Once a transaction of the command landed, a line that closes with "Nothing was sent." or "Nothing was signed."
 * (the rpc row for a later step's dropped read, a later step's simulated revert) is untrue for the command, and FLOWS
 * §6 J3 and §8 have no line for a partly done seller flow, so that closing sentence is dropped and the rest, with
 * its one next action, is kept: "Can't reach Celo at {rpc}." / "Retry or set another `--rpc`." (re-running skips
 * what landed). A transaction whose own outcome a dropped RPC hides is `send`'s sent-unconfirmed row. // not in FLOWS
 */
function afterSigning(e: unknown): unknown {
  if (!(e instanceof CliError)) return e;
  const kept = e.message.replace(NOTHING_DONE, '');
  return kept === e.message ? e : new CliError(e.code, kept, e.next);
}

/** The closing clause that is only true while nothing of the command has been signed. */
const NOTHING_DONE = / Nothing was (?:sent|signed)\.$/;
