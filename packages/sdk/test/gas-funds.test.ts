import { afterEach, describe, expect, it } from 'vitest';
import { InsufficientGasFundsError, TX_GAS_CAP, canPayGas, gasTerms, isInsufficientFundsReply } from '../src/gas.ts';
import { RpcFailure } from './fakes/chain.ts';
import { makeWorld, type World } from './fakes/world.ts';

// T21 adversary r7 follow-up: `cancelAuthorization` is the one buyer action that pays gas (FLOWS J1: "on-chain
// cancel, ~0.0004 CELO gas"). A payer without CELO for it gets InsufficientGasFundsError, before the transaction is
// signed or when the node refuses the broadcast, and the entry stays open: nothing was sent.

let w: World;
afterEach(async () => {
  await w?.close();
});

async function refusedCall(): Promise<`0x${string}`> {
  w = await makeWorld({ waitForExpiry: false });
  w.gw.behavior = { paid: 'refuse' };
  const r0 = await w.client.payAndVerify(w.url, { body: w.body });
  expect(r0.outcome).toBe('refused');
  return r0.requestId;
}

function failBroadcast(err: () => Error): void {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[] = []) => {
    if (m === 'eth_sendRawTransaction') {
      w.chain.calls.push(m);
      throw err();
    }
    return orig(m, p);
  };
}

// The fake estimates 100,000 gas at 1 gwei price and 1 gwei tip: 120,000 x 3 gwei.
const CANCEL_COST = 120_000n * 3_000_000_000n;

describe('cancelAuthorization from a payer without CELO for gas', () => {
  it('a zero balance: refused before the transaction is signed, nothing broadcast, entry still open', async () => {
    const id = await refusedCall();
    w.chain.setAccount(w.account.address, { code: '0x', nonce: 0n, balance: 0n });
    const e = await w.client.cancelAuthorization(id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InsufficientGasFundsError);
    expect(e).toMatchObject({ address: w.account.address.toLowerCase(), chainId: w.chain.chainId, maxCost: CANCEL_COST, refusedByNode: false });
    expect(w.chain.calls).not.toContain('eth_sendRawTransaction');
    expect(w.client.ledger.get(id)!.state).not.toBe('not_charged');
  });

  it('exactly the most the cancel can cost is enough', async () => {
    const id = await refusedCall();
    w.chain.setAccount(w.account.address, { code: '0x', nonce: 0n, balance: CANCEL_COST });
    expect(await w.client.cancelAuthorization(id)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.client.ledger.get(id)!.state).toBe('not_charged');
  });

  it('the node refuses the signed broadcast for funds: refusedByNode, node text not kept, entry still open', async () => {
    const id = await refusedCall();
    failBroadcast(() => new RpcFailure('insufficient funds for gas * price + value: balance 0, tx cost 360000000000000, overshot 1 NODE-TEXT'));
    const e = await w.client.cancelAuthorization(id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InsufficientGasFundsError);
    expect(e).toMatchObject({ refusedByNode: true, maxCost: CANCEL_COST });
    expect((e as Error).message).not.toMatch(/NODE-TEXT/);
    expect(w.client.ledger.get(id)!.state).not.toBe('not_charged');
  });

  it('another -32000 refusal at broadcast is not read as missing CELO', async () => {
    const id = await refusedCall();
    failBroadcast(() => new RpcFailure('nonce too low: insufficient funds later in the text'));
    const e = await w.client.cancelAuthorization(id).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(InsufficientGasFundsError);
  });
});

describe('the shared gas rule', () => {
  it('gasTerms pads by 20% below the cap; maxFeePerGas = 2 x price + tip; maxCost = gas x maxFeePerGas', () => {
    expect(gasTerms(100_000n, 25n, 1n)).toEqual({ gas: 120_000n, maxFeePerGas: 51n, maxPriorityFeePerGas: 1n, maxCost: 120_000n * 51n });
    expect(gasTerms(TX_GAS_CAP, 1n, 0n).gas).toBe(TX_GAS_CAP - 1n);
  });

  it('canPayGas is balance >= maxCost', () => {
    const t = gasTerms(100_000n, 1n, 1n);
    expect(canPayGas(t.maxCost, t)).toBe(true);
    expect(canPayGas(t.maxCost - 1n, t)).toBe(false);
  });

  it('isInsufficientFundsReply: code -32000 and a message that starts "insufficient funds"', () => {
    expect(isInsufficientFundsReply(-32000, 'insufficient funds for gas * price + value: balance 0')).toBe(true);
    expect(isInsufficientFundsReply(-32000, 'Insufficient funds for gas * price + value')).toBe(true);
    expect(isInsufficientFundsReply(-32003, 'insufficient funds for gas * price + value')).toBe(false);
    expect(isInsufficientFundsReply(3, 'insufficient funds')).toBe(false);
    expect(isInsufficientFundsReply(-32000, 'execution reverted: insufficient funds')).toBe(false);
    expect(isInsufficientFundsReply(-32000, undefined)).toBe(false);
  });
});
