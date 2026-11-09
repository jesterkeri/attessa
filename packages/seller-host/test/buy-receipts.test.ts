import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BuyPaidSource, type BuyReceipt } from '../src/buy.ts';
import { FakeX402, USDC } from './fake-x402.ts';

// Build with buy asks for proof of payment, so a paid read must leave its settlement behind. Test doubles only.
const ACCOUNT = privateKeyToAccount(generatePrivateKey());
const CFG = { capabilityId: 'test-capability', url: 'https://buy.example.test/rpc', maxAmountAtomic: 10_000n };
const CALLS = [{ method: 'eth_blockNumber', params: [] as unknown[] }];
const TX = `0x${'ab'.repeat(32)}`;

describe('proof of a paid read', () => {
  let x: FakeX402;
  beforeEach(async () => {
    x = new FakeX402();
    await x.start();
  });
  afterEach(async () => {
    await x.stop();
  });

  it('records the settlement transaction, payer, asset and amount, and never the signature', async () => {
    x.settlementTx = TX;
    const got: BuyReceipt[] = [];
    await new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl, (r) => void got.push(r)).batch(CALLS, new AbortController().signal);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ capabilityId: 'test-capability', txHash: TX, asset: USDC, amount: '10000', outcome: 'confirmed', status: 200 });
    expect(got[0]!.from.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());
    expect(got[0]!.nonce).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(JSON.stringify(got[0])).not.toMatch(/signature/i);
  });

  it('a reply with no settlement header still records who paid and the nonce, so the transfer can be found on the token', async () => {
    const got: BuyReceipt[] = [];
    await new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl, (r) => void got.push(r)).batch(CALLS, new AbortController().signal);
    expect(got[0]!.txHash).toBeNull();
    expect(got[0]!.from.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());
  });

  it('a paid request the service answers with an error still leaves a receipt: the money may have moved', async () => {
    x.paidMode = 'http500';
    const got: BuyReceipt[] = [];
    await expect(new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl, (r) => void got.push(r)).batch(CALLS, new AbortController().signal)).rejects.toThrow(/http_500/);
    expect(got).toHaveLength(1);
    expect(got[0]!.outcome).toBe('ambiguous');
  });

  it('a failed receipt write does not turn a paid read into a failure, and pays once', async () => {
    const reply = await new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl, () => {
      throw new Error('disk full');
    }).batch(CALLS, new AbortController().signal);
    expect(reply).toHaveLength(1);
    expect(x.payments).toHaveLength(1);
  });
});
