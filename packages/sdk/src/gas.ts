/**
 * The gas terms every Attessa transaction is signed with (the CLI's registry writes and the SDK's
 * `cancelAuthorization`), and the funds rule a Celo node applies before it admits one. One copy, so both refuse an
 * unfunded wallet the same way.
 */

/** EIP-7825 per-transaction gas cap; every registry function stays below it (SPEC §3.4, C1.1). */
export const TX_GAS_CAP = 16_777_216n;

export interface GasTerms {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The most the transaction can cost: gas x maxFeePerGas (value is always 0). */
  maxCost: bigint;
}

/** Intrinsic gas of bytes appended to calldata (EIP-2028): 4 per zero byte, 16 per non-zero byte. */
export function appendedDataGas(data: string | null | undefined): bigint {
  if (!data) return 0n;
  let gas = 0n;
  for (let i = 2; i + 1 < data.length; i += 2) gas += data.slice(i, i + 2) === '00' ? 4n : 16n;
  return gas;
}

/** The transaction with its attribution suffix can't fit one transaction's gas cap. Thrown before anything is signed. */
export class GasCapError extends Error {
  readonly required: bigint;
  constructor(required: bigint) {
    super(`needs ${required} gas with its attribution suffix, above the ${TX_GAS_CAP} per-transaction cap`);
    this.name = 'GasCapError';
    this.required = required;
  }
}

/**
 * The estimate padded by 20% (below the cap), and maxFeePerGas = 2 x gas price + tip. Estimates run on calldata without
 * the attribution suffix, so `suffix` is added before the pad, and a suffixed send that can't fit the cap is refused.
 */
export function gasTerms(estimate: bigint, gasPrice: bigint, tip: bigint, suffix?: string | null): GasTerms {
  const required = estimate + appendedDataGas(suffix);
  if (suffix && required >= TX_GAS_CAP) throw new GasCapError(required);
  const padded = (required * 12n) / 10n;
  const gas = padded < TX_GAS_CAP ? padded : TX_GAS_CAP - 1n;
  const maxFeePerGas = gasPrice * 2n + tip;
  return { gas, maxFeePerGas, maxPriorityFeePerGas: tip, maxCost: gas * maxFeePerGas };
}

/**
 * The node's admission rule for a value-0 transaction: balance >= gas x maxFeePerGas. eth_call and eth_estimateGas
 * without fee fields never check it, so the sender reads the balance and applies it before signing.
 */
export function canPayGas(balance: bigint, t: GasTerms): boolean {
  return balance >= t.maxCost;
}

/**
 * A node's refusal of a broadcast for lack of funds: geth's (and op-geth's) txpool error `core.ErrInsufficientFunds`,
 * JSON-RPC -32000 "insufficient funds for gas * price + value: …". Narrow on purpose: any other -32000 is not this.
 */
export function isInsufficientFundsReply(code: unknown, message: unknown): boolean {
  return code === -32000 && typeof message === 'string' && /^insufficient funds\b/i.test(message);
}

/**
 * Thrown by `cancelAuthorization` when the wallet can't pay the cancel's gas: before the transaction is signed when
 * the balance read shows it (`refusedByNode: false`), or when the node refused the signed broadcast
 * (`refusedByNode: true`). Either way nothing was sent. The node's text is not kept.
 */
export class InsufficientGasFundsError extends Error {
  readonly address: string;
  readonly chainId: number;
  readonly maxCost: bigint;
  readonly refusedByNode: boolean;
  constructor(address: string, chainId: number, maxCost: bigint, refusedByNode: boolean) {
    super(`${address} can't pay up to ${maxCost} wei of gas${refusedByNode ? ' (refused by the node)' : ''}`);
    this.name = 'InsufficientGasFundsError';
    this.address = address;
    this.chainId = chainId;
    this.maxCost = maxCost;
    this.refusedByNode = refusedByNode;
  }
}

/** A JSON-RPC reply that is a contract revert: code 3 (geth's revert with data), or a message saying "execution reverted". */
export function isRevertReply(code: unknown, message: unknown): boolean {
  return code === 3 || (typeof message === 'string' && /\bexecution reverted\b/i.test(message));
}

/** An error and its `cause` chain (viem wraps a node's reply in one or more errors), with the fields replies carry. */
export function causes(e: unknown): Array<{ code?: unknown; details?: unknown; message?: unknown }> {
  const out: Array<{ code?: unknown; details?: unknown; message?: unknown }> = [];
  for (let c: unknown = e; c && typeof c === 'object' && out.length < 16; c = (c as { cause?: unknown }).cause) out.push(c as never);
  return out;
}
