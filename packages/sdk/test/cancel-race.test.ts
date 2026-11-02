import type { Address, Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { AlreadyUsedError, AttestError } from '../src/client.ts';
import { RpcError } from '../src/chain.ts';
import { RpcFailure } from './fakes/chain.ts';
import { makeWorld, type World } from './fakes/world.ts';

// T21 adversary r8 fix: the facilitator settles between cancelAuthorization's state check and its estimate, and the
// estimate reverts (FiatToken "authorization is used or canceled"). The SDK reads the state again: used is
// AlreadyUsedError with the settlement tx (FLOWS §8 "cancel: already used"); any other revert stays a revert.

let w: World;
afterEach(async () => {
  await w?.close();
});

async function openCall(): Promise<{ id: Hex; payer: Address; nonce: Hex; amount: bigint }> {
  w = await makeWorld({ waitForExpiry: false });
  w.gw.behavior = { paid: 'refuse' };
  const r0 = await w.client.payAndVerify(w.url, { body: w.body });
  expect(r0.outcome).toBe('refused');
  const e = w.client.ledger.get(r0.requestId)!;
  return { id: r0.requestId, payer: e.payer as Address, nonce: e.nonce as Hex, amount: BigInt(e.amount) };
}

function revertEstimate(before: () => void, code: number, message: string): void {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[] = []) => {
    if (m === 'eth_estimateGas') {
      before();
      w.chain.calls.push(m);
      throw new RpcFailure(message, code);
    }
    return orig(m, p);
  };
}

describe('cancelAuthorization when its estimate reverts', () => {
  it('settled after the state check (code 3): AlreadyUsedError with the settlement tx, nothing sent', async () => {
    const c = await openCall();
    let settleTx: Hex | undefined;
    revertEstimate(() => void (settleTx ??= w.chain.settle(c.payer, w.payTo, c.amount, c.nonce)), 3, 'execution reverted: FiatTokenV2: authorization is used or canceled');
    const e = await w.client.cancelAuthorization(c.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AlreadyUsedError);
    expect((e as AlreadyUsedError).tx).toBe(settleTx);
    expect(w.chain.calls).not.toContain('eth_sendRawTransaction');
  });

  it('settled after the state check, revert as -32000 "execution reverted": the same AlreadyUsedError', async () => {
    const c = await openCall();
    revertEstimate(() => void (w.chain.authUsed(c.payer, c.nonce) || w.chain.settle(c.payer, w.payTo, c.amount, c.nonce)), -32000, 'execution reverted');
    await expect(w.client.cancelAuthorization(c.id)).rejects.toBeInstanceOf(AlreadyUsedError);
  });

  it('a revert while the authorization is still unused stays a revert (RpcError), and the call stays open', async () => {
    const c = await openCall();
    revertEstimate(() => {}, 3, 'execution reverted: something else');
    const e = await w.client.cancelAuthorization(c.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e).not.toBeInstanceOf(AlreadyUsedError);
    expect(e).not.toBeInstanceOf(AttestError);
    expect(w.client.ledger.get(c.id)!.state).not.toBe('not_charged');
  });

  it('a non-revert estimate failure is not read as a race: RpcError, no state re-read decides it', async () => {
    const c = await openCall();
    revertEstimate(() => void (w.chain.authUsed(c.payer, c.nonce) || w.chain.settle(c.payer, w.payTo, c.amount, c.nonce)), -32005, 'rate limited');
    const e = await w.client.cancelAuthorization(c.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e).not.toBeInstanceOf(AlreadyUsedError);
  });
});
