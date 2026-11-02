import type { Address, Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { AlreadyUsedError, AttestError, CancelInterruptedError, CancelRevertedError, CancelUndecidedError } from '../src/client.ts';
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

  it('a revert while the authorization is still unused stays a revert (CancelRevertedError, nothing sent), and the call stays open', async () => {
    const c = await openCall();
    revertEstimate(() => {}, 3, 'execution reverted: something else');
    const e = await w.client.cancelAuthorization(c.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CancelRevertedError);
    expect(e).toMatchObject({ tx: undefined, validBefore: BigInt(w.client.ledger.get(c.id)!.validBefore!) });
    expect(w.chain.calls).not.toContain('eth_sendRawTransaction');
    expect(e).not.toBeInstanceOf(AttestError);
    expect(w.client.ledger.get(c.id)!.state).not.toBe('not_charged');
  });

  it('a non-revert estimate failure is not read as a race: no state re-read decides it; after the signature it is CancelInterruptedError (r10)', async () => {
    const c = await openCall();
    revertEstimate(() => void (w.chain.authUsed(c.payer, c.nonce) || w.chain.settle(c.payer, w.payTo, c.amount, c.nonce)), -32005, 'rate limited');
    const e = await w.client.cancelAuthorization(c.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CancelInterruptedError);
    expect((e as CancelInterruptedError).tx).toBeUndefined();
    expect(e).not.toBeInstanceOf(AlreadyUsedError);
  });
});

describe('cancelAuthorization reads the decision from logs, polling briefly', () => {
  it('settled meanwhile, re-read on a node one block behind: AlreadyUsedError with the settlement tx', async () => {
    const c = await openCall();
    let settleTx: Hex | undefined;
    revertEstimate(() => {
      settleTx ??= w.chain.settle(c.payer, w.payTo, c.amount, c.nonce);
      w.chain.headLag = 1;
    }, 3, 'execution reverted: FiatTokenV2: authorization is used or canceled');
    const e = await w.client.cancelAuthorization(c.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AlreadyUsedError);
    expect((e as AlreadyUsedError).tx).toBe(settleTx);
  });

  it('state reads used-or-cancelled but no log appears while polling: CancelUndecidedError, never AlreadyUsedError without a tx', async () => {
    const c = await openCall();
    w.chain.settle(c.payer, w.payTo, c.amount, c.nonce);
    const orig = w.chain.request.bind(w.chain);
    w.chain.request = async (m: string, p: unknown[] = []) => (m === 'eth_getLogs' ? [] : orig(m, p));
    const e = await w.client.cancelAuthorization(c.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CancelUndecidedError);
    expect(w.chain.calls).not.toContain('eth_sendRawTransaction');
  });

  it('the AuthorizationUsed log shows up on the second read: AlreadyUsedError with its tx', async () => {
    const c = await openCall();
    const tx = w.chain.settle(c.payer, w.payTo, c.amount, c.nonce);
    const orig = w.chain.request.bind(w.chain);
    let reads = 0;
    w.chain.request = async (m: string, p: unknown[] = []) => (m === 'eth_getLogs' && reads++ < 2 ? [] : orig(m, p));
    const e = await w.client.cancelAuthorization(c.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AlreadyUsedError);
    expect((e as AlreadyUsedError).tx).toBe(tx);
  });
});

describe('cancelAuthorization when the RPC drops (T21 r10)', () => {
  it('before anything is signed: the read\'s RpcError, unwrapped, and no signature', async () => {
    const c = await openCall();
    w.chain.logsDown = true;
    const signs = w.signSpy.mock.calls.length;
    const e = await w.client.cancelAuthorization(c.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(w.signSpy.mock.calls.length).toBe(signs);
  });

  it('after the permission is signed, before the broadcast: CancelInterruptedError without a tx', async () => {
    const c = await openCall();
    const orig = w.chain.request.bind(w.chain);
    w.chain.request = async (m: string, p: unknown[] = []) => {
      if (m === 'eth_gasPrice') throw new RpcFailure('connect ECONNREFUSED');
      return orig(m, p);
    };
    const e = await w.client.cancelAuthorization(c.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CancelInterruptedError);
    expect((e as CancelInterruptedError).tx).toBeUndefined();
  });

  it('after the broadcast, the receipt poll fails: CancelInterruptedError with the cancel tx, polled at most receiptWaitMs', async () => {
    const c = await openCall();
    const orig = w.chain.request.bind(w.chain);
    let raw: `0x${string}` | undefined;
    let polls = 0;
    w.chain.request = async (m: string, p: unknown[] = []) => {
      if (m === 'eth_getTransactionReceipt' && raw) {
        polls++;
        throw new RpcFailure('connect ECONNREFUSED');
      }
      const r = await orig(m, p);
      if (m === 'eth_sendRawTransaction') raw = p[0] as `0x${string}`;
      return r;
    };
    const e = await w.client.cancelAuthorization(c.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CancelInterruptedError);
    expect((e as CancelInterruptedError).tx).toBe(keccak256(raw!));
    expect(polls).toBeLessThanOrEqual(2);
  });
});
