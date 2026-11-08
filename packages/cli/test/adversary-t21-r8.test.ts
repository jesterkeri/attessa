import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
// Absolute paths because this file was written outside the working copy; inside packages/cli/test they are
// '../../sdk/test/fakes/chain.ts', '../../sdk/test/fakes/gateway.ts', '../src/context.ts' and '../src/index.ts'.
import { FakeChain, RpcFailure } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// T21 adversary r8. `attessa cancel` races the facilitator: the SDK reads authorizationState (unused), then the
// facilitator's settlement lands, then the cancel's eth_estimateGas reverts on a real node (FiatToken
// "authorization is used or canceled"). The fake chain's estimateGas never reverts, so the test makes it do what a
// geth node does (JSON-RPC code 3, "execution reverted: ..."). FLOWS §8 "cancel: already used" and §5 rows 13/28
// say this is `already_used` -> reconcile: "Too late to cancel: the payment went through (tx {h}). Fetching your
// answer." The CLI prints "Unexpected error (RpcError)" instead.

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

async function buyerWorld() {
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
  const home = mkdtempSync(join(tmpdir(), 'attessa-cli-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    home,
    payTo,
    url: `${origin}/v1/evaluate`,
    transcript: [] as string[],
    out: [] as string[],
    err: [] as string[],
    env: { ATTESSA_REGISTRY: chain.registry } as Record<string, string | undefined>,
    deps(): Deps {
      return {
        io: {
          out: (l) => void (w.out.push(l), w.transcript.push(l)),
          err: (l) => void (w.err.push(l), w.transcript.push(l)),
          confirm: async () => true,
        },
        env: w.env,
        cwd: home,
        home,
        keychain,
        rpc: () => {
          throw new Error('buyer commands use the SDK transport');
        },
        runner: { run: async () => ({ code: 1, stdout: '', stderr: 'no runner in buyer tests' }) },
        fetch,
        enclave: () => {
          throw new Error('no enclave in buyer tests');
        },
        readFile: (p) => readFileSync(p),
        writeFile: (p, d) => writeFileSync(p, d),
        exists: (p) => existsSync(p),
        readdir: (p) => readdirSync(p),
        sleep: async () => {},
        arch: 'x64',
        sdk: {
          transport: chain.transport(),
          sleep: async (ms: number) => chain.advance(Math.max(1, ms / 1000)),
          receiptWaitMs: 2000,
          httpTimeoutMs: 5000,
        },
      };
    },
    cli(...argv: string[]) {
      return run(argv, w.deps());
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
  return w;
}

let w: Awaited<ReturnType<typeof buyerWorld>>;
afterEach(async () => w?.close());

const LOCAL = ['--network', 'local', '--rpc', 'http://127.0.0.1:1'];

describe('attessa cancel while the facilitator settles (FLOWS §8 cancel: already used)', () => {
  it('settled between the SDK state check and the cancel estimate: "Too late to cancel", not "Unexpected error"', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    w.gw.behavior = { paid: 'pending_no_settle' };
    expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--no-wait')).toBe(1);
    const e = w.pending()[0]! as { requestId: Hex; payer: Address; nonce: Hex; amount: string };
    expect(w.chain.authUsed(e.payer, e.nonce)).toBe(false);

    // The facilitator's settlement lands just before the buyer's eth_estimateGas, which then reverts as geth does.
    const orig = w.chain.request.bind(w.chain);
    w.chain.request = async (m: string, p: unknown[] = []) => {
      if (m === 'eth_estimateGas') {
        if (!w.chain.authUsed(e.payer, e.nonce)) w.chain.settle(e.payer, w.payTo, BigInt(e.amount), e.nonce);
        throw new RpcFailure('execution reverted: FiatTokenV2: authorization is used or canceled', 3);
      }
      return orig(m, p);
    };

    w.transcript.length = 0;
    w.err.length = 0;
    await w.cli('cancel', e.requestId, ...LOCAL, '--yes');
    expect(w.chain.authUsed(e.payer, e.nonce)).toBe(true);
    expect(w.err.join('\n')).not.toMatch(/Unexpected error/);
    expect(w.transcript[0]).toMatch(/^Too late to cancel: the payment went through \(tx 0x[0-9a-f]{4}…[0-9a-f]{2}\)\. Fetching your answer\.$/);
  });
});
