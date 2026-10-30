import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { keccak256, stringToBytes, type Address, type Hex, type LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { originHash } from '@attessa/core';
import { createAttestClient } from '../../src/client.ts';
import type { ClientOptions, Limits } from '../../src/types.ts';
import { FakeChain } from './chain.ts';
import { FakeGateway } from './gateway.ts';

export const AGENT = 7n;
export const PRICE = 20000n;

/** A fresh random key, generated in-test. It never holds anything. */
export function randomAccount(): LocalAccount {
  return privateKeyToAccount(generatePrivateKey());
}

export interface WorldOpts {
  waitForExpiry?: boolean;
  limits?: Partial<Limits>;
  client?: Partial<ClientOptions>;
}

/** Chain + registry state + a running fake gateway + an SDK client with a signing spy. */
export async function makeWorld(opts: WorldOpts = {}) {
  const chain = new FakeChain();
  const operator = randomAccount().address.toLowerCase() as Address;
  const payTo = randomAccount().address.toLowerCase() as Address;
  const enclave = randomAccount();
  const releaseId = keccak256(stringToBytes(`release-${Math.random()}`));
  chain.approveRelease(AGENT, releaseId);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, releaseId, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);

  const account = randomAccount();
  const signSpy = vi.spyOn(account, 'signTypedData');
  const dataDir = mkdtempSync(join(tmpdir(), 'attessa-sdk-'));
  const hooks: { onSleep?: () => void } = {};
  const sleeps = { count: 0 };
  const sleep = async (ms: number) => {
    sleeps.count++;
    chain.advance(Math.max(1, ms / 1000));
    hooks.onSleep?.();
  };
  const limits: Limits = { maxAmountPerCall: 100_000n, dailyCap: 1_000_000n, ...opts.limits };
  const mkClient = (extra: Partial<ClientOptions> = {}, acct: LocalAccount = account) =>
    createAttestClient(
      { network: 'local', account: acct, limits: { usdc: limits, usat: limits }, asset: 'usdc', dataDir, waitForExpiry: opts.waitForExpiry ?? true },
      { registry: chain.registry, transport: chain.transport(), sleep, receiptWaitMs: 2000, httpTimeoutMs: 5000, ...opts.client, ...extra },
    );
  const client = mkClient();
  const body = JSON.stringify({ chainId: String(chain.chainId), payTo, asset: chain.asset, amount: '20000' });
  return {
    chain,
    gw,
    client,
    mkClient,
    account,
    signSpy,
    dataDir,
    origin,
    url: `${origin}/v1/evaluate`,
    body,
    releaseId,
    enclave,
    operator,
    payTo,
    hooks,
    sleeps,
    /** EIP-3009 TransferWithAuthorization signatures made so far. */
    transferSignatures: () => signSpy.mock.calls.filter((c) => (c[0] as { primaryType: string }).primaryType === 'TransferWithAuthorization').length,
    async close() {
      await gw.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export type World = Awaited<ReturnType<typeof makeWorld>>;

export const hex32 = (label: string): Hex => keccak256(stringToBytes(label));
