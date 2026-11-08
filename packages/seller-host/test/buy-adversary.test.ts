import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BuyPaidSource } from '../src/buy.ts';
import { parseConfig } from '../src/config.ts';
import { BuySpendGuard } from '../src/guard.ts';
import { HttpRpcSource, InputFetcher } from '../src/inputs.ts';
import { FakeRpc } from './fake-rpc.ts';
import { FakeX402 } from './fake-x402.ts';

// Adversary probes for T28 (commit 312ce7b), kept where the behaviour still exists on the library route. Test doubles only.
const PAY_TO = '0x2222222222222222222222222222222222222222';
const ACCOUNT = privateKeyToAccount(generatePrivateKey());
const CFG = { capabilityId: 'test-capability', url: 'https://buy.example.test/rpc', maxAmountAtomic: 10_000n };

describe('T28 adversary', () => {
  it('source: a capability id the enclave would refuse (bad_inputs) is refused at config time', () => {
    // enclave/src/rules.rs is_source: buy:<id>, id = [A-Za-z0-9._:/-]+
    for (const id of ['chainstack+celo', 'a@b', 'a,b', "a'b", 'a\\b', 'a"b', 'a%b', 'a$b']) {
      expect(() => new BuyPaidSource({ ...CFG, capabilityId: id }, ACCOUNT), id).toThrow();
    }
  });

  it('source: a buy block without capabilityId does not become source "buy:undefined"', () => {
    const base = { network: 'mainnet', registry: '0x' + '1'.repeat(40), agentId: '1', origin: 'https://attessa.example.com', stateDir: '/tmp/s', gatewayDbPath: '/tmp/g.db' };
    expect(() => parseConfig({ ...base, buy: { url: 'https://buy.example.test/rpc', maxAmount: '0.01' } })).toThrow();
  });
});

describe('T28 adversary: guard failure must not fail the evaluate', () => {
  let forno: FakeRpc;
  let x: FakeX402;
  beforeEach(async () => {
    forno = new FakeRpc();
    x = new FakeX402();
    await forno.start();
    await x.start();
    forno.accounts.set(PAY_TO, { code: '0x6001', nonce: 1n, balance: 5n });
  });
  afterEach(async () => {
    await forno.stop();
    await x.stop();
  });
  it('an unwritable guard state falls back to Forno instead of failing the evaluate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-adv-'));
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    const guard = new BuySpendGuard(join(blocker, 'sub', 'g.json'), { settledSince: () => 0n }); // mkdir fails: ENOTDIR
    const buy = new BuyPaidSource(CFG, ACCOUNT, x.fetchImpl);
    const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy, guard, timeoutMs: 1000 });
    expect((await f.fetch(PAY_TO, new Date('2026-11-10T12:00:00Z'))).source).toBe('forno');
    expect(x.unpaid + x.payments.length).toBe(0);
  });
});
