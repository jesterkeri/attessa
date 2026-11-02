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

/** The estimate padded by 20% (below the cap), and maxFeePerGas = 2 x gas price + tip. */
export function gasTerms(estimate: bigint, gasPrice: bigint, tip: bigint): GasTerms {
  const padded = (estimate * 12n) / 10n;
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
