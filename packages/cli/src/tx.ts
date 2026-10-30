import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
} from 'viem';
import { CERT_MANAGER_ABI, REGISTRY_ABI } from './abi.ts';
import type { Chain, Deps, Global } from './context.ts';
import { CliError, ERR } from './copy.ts';
import { RpcError, RpcUnavailable, revertData } from './rpc.ts';

/** Contract reads and writes. Writes are planned and simulated with `eth_call`; only `send` broadcasts. */

/** EIP-7825 per-transaction gas cap; every registry function stays below it (SPEC §3.4, C1.1). */
export const TX_GAS_CAP = 16_777_216n;

export async function read<const abi extends Abi, fn extends ContractFunctionName<abi, 'view'>>(
  c: Chain,
  to: Address,
  abi: abi,
  functionName: fn,
  args: ContractFunctionArgs<abi, 'view', fn>,
): Promise<any> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  let out: unknown;
  try {
    out = await c.rpc.request('eth_call', [{ to, data }, 'latest']);
  } catch (e) {
    if (e instanceof RpcUnavailable) throw ERR.rpcUnavailable(c.rpc.url);
    throw e;
  }
  return decodeFunctionResult({ abi, functionName, data: out as Hex } as never);
}

export interface Head {
  number: bigint;
  timestamp: bigint;
}

export async function head(c: Chain): Promise<Head> {
  const b = (await c.rpc.request('eth_getBlockByNumber', ['latest', false])) as { number: string; timestamp: string };
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

/** `eth_call` then `eth_estimateGas`, from `from`, at latest. Never sends anything. */
export async function simulate(c: Chain, from: Address, step: Step): Promise<Simulation> {
  const tx = { from, to: step.to, data: step.data };
  try {
    await c.rpc.request('eth_call', [tx, 'latest']);
    const gas = BigInt((await c.rpc.request('eth_estimateGas', [tx])) as string);
    return { ok: true, gas };
  } catch (e) {
    if (e instanceof RpcUnavailable) throw ERR.rpcUnavailable(c.rpc.url);
    if (e instanceof RpcError) return { ok: false, revert: decodeRevert(e), message: e.message };
    throw e;
  }
}

export async function gasPrice(c: Chain): Promise<bigint> {
  return BigInt((await c.rpc.request('eth_gasPrice', [])) as string);
}

function gasLimit(estimate: bigint): bigint {
  const padded = (estimate * 12n) / 10n;
  return padded < TX_GAS_CAP ? padded : TX_GAS_CAP - 1n;
}

export interface Sent {
  hash: Hex;
  blockNumber: bigint;
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
  const [nonceHex, price, tip] = await Promise.all([
    c.rpc.request('eth_getTransactionCount', [account.address, 'pending']),
    gasPrice(c),
    c.rpc.request('eth_maxPriorityFeePerGas', []).then((v) => BigInt(v as string)),
  ]);
  const maxFeePerGas = price * 2n + tip;
  const raw = await account.signTransaction({
    type: 'eip1559',
    chainId: c.chainId,
    nonce: Number(BigInt(nonceHex as string)),
    to: step.to,
    data: step.data,
    value: 0n,
    gas: gasLimit(sim.gas),
    maxFeePerGas,
    maxPriorityFeePerGas: tip,
  });
  const hash = (await c.rpc.request('eth_sendRawTransaction', [raw])) as Hex;
  for (let i = 0; i < 180; i++) {
    const r = (await c.rpc.request('eth_getTransactionReceipt', [hash])) as { status: string; blockNumber: string; gasUsed: string } | null;
    if (r) {
      if (r.status !== '0x1') {
        if (BigInt(r.gasUsed) >= gasLimit(sim.gas)) throw ERR.gasTooLow(step.label);
        throw new CliError('tx_reverted', `The transaction reverted at ${step.label} (tx ${hash}). Nothing changed.`, 'Run the command again to see why.');
      }
      return { hash, blockNumber: BigInt(r.blockNumber) };
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
): Promise<'sent' | 'planned' | 'cancelled'> {
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
  if (!g.yes && !(await io.confirm(plan.yesWord))) return 'cancelled';
  for (let i = 0; i < plan.steps.length; i++) await onSent(i, await send(c, deps, plan.steps[i]!, onRevert));
  return 'sent';
}
