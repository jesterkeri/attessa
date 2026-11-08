import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// T21 adversary r54. A signed call the gateway refuses with `payment_invalid{insufficient_funds}` (the facilitator's
// /verify found the buyer's wallet short of the price) ends without its one next action.
//
// FLOWS §8 "Errors and refusals", row "payment invalid":
//   What happened: "Not paid: the payment permission was refused because {plain facilitator reason}."
//   Why: e.g. "your wallet has 0.01 USDC and the price is 0.02"
//   The one next action: "Add at least {n} USDC to {address}."
//   Machine: `payment_invalid{insufficient_funds|...}` -> per reason
// FLOWS §9 (FLOWS.md:832) "Recovery | Every error row has one next action".
//
// The CLI prints the "Not paid" line (copy.ts signedRefusal), waits, and ends "Not charged: confirmed on Celo ..."
// with exit 1; no line ever tells the buyer to fund the wallet, so re-running the same call fails the same way.

const AGENT = 412n;
const SOURCE = 'https://github.com/acme/risk/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

class MemKeychain implements Keychain {
  store = new Map<string, string>();
  async getPassword(s: string, a: string) {
    return this.store.get(`${s}/${a}`) ?? null;
  }
  async setPassword(s: string, a: string, p: string) {
    this.store.set(`${s}/${a}`, p);
  }
}

async function world() {
  const chain = new FakeChain({ startTime: 1_793_000_000n, startBlock: 31_204_000n });
  const rnd = () => privateKeyToAccount(generatePrivateKey());
  const operator = rnd().address.toLowerCase() as Address;
  const payTo = rnd().address.toLowerCase() as Address;
  const enclave = rnd();
  const releaseId = keccak256(stringToBytes(`release-${Math.random()}`));
  chain.approveRelease(AGENT, releaseId, SOURCE);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, releaseId, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv-r54-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    home,
    keychain,
    url: `${origin}/v1/evaluate`,
    out: [] as string[],
    err: [] as string[],
    deps(): Deps {
      return {
        io: { out: (l) => void w.out.push(l), err: (l) => void w.err.push(l), confirm: async () => true },
        env: { ATTESSA_REGISTRY: chain.registry },
        cwd: home,
        home,
        keychain,
        rpc: () => {
          throw new Error('unused');
        },
        runner: { run: async () => ({ code: 1, stdout: '', stderr: '' }) },
        fetch,
        enclave: () => {
          throw new Error('unused');
        },
        readFile: (p) => readFileSync(p),
        writeFile: (p, d) => writeFileSync(p, d),
        exists: (p) => existsSync(p),
        readdir: (p) => readdirSync(p),
        sleep: async () => {},
        arch: 'x64',
        sdk: { transport: chain.transport(), sleep: async (ms: number) => chain.advance(Math.max(1, ms / 1000)), receiptWaitMs: 2000, httpTimeoutMs: 5000 },
      };
    },
    cli: (...argv: string[]) => run(argv, w.deps()),
    call: (...extra: string[]) => run(['call', w.url, '--body', 'tx.json', '--network', 'local', '--rpc', 'http://127.0.0.1:1', ...extra], w.deps()),
    wallet(): string {
      const key = [...keychain.store.values()][0]!;
      return privateKeyToAccount(key as `0x${string}`).address.toLowerCase();
    },
    pending(): Array<Record<string, unknown>> {
      const p = join(home, '.attessa', 'pending.jsonl');
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    async close() {
      await gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, 'tx.json'), JSON.stringify({ chainId: String(chain.chainId), payTo, asset: chain.asset, amount: '20000' }));
  expect(await w.cli('init', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
  w.out.length = 0;
  w.err.length = 0;
  return w;
}

let w: Awaited<ReturnType<typeof world>> | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('adversary T21 r54: payment_invalid{insufficient_funds} keeps its FLOWS next action', () => {
  it('a signed call refused for insufficient funds ends with "Add at least {n} USDC to {address}."', async () => {
    w = await world();
    // The facilitator's /verify refused the permission: the wallet can't cover the price (SPEC §6.2, §10 body).
    w.gw.behavior = { paid: 'refuse', refuseWith: { status: 402, error: 'payment_invalid', detail: 'insufficient_funds' } };
    const code = await w.call();
    const transcript = [...w.out, ...w.err];
    // The path under test: the refusal was reported and the call was decided not charged.
    expect(code).toBe(1);
    expect(w.pending()[0]!.state).toBe('not_charged');
    expect(transcript).toContain('Not paid: the payment permission was refused because insufficient funds.');
    // FLOWS §8 "payment invalid": the one next action names an amount and the wallet to fund.
    const addr = w.wallet();
    const next = new RegExp(`^Add at least \\d+(?:\\.\\d+)? USDC to ${addr}\\.$`, 'i');
    expect(transcript.filter((l) => next.test(l))).toHaveLength(1);
  });
});
