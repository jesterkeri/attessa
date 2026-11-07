import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// T21 adversary r31. The r30 fix maps a buyer command's failed file write to `disk_write_failed` by the error's own
// `code` (copy.ts diskError). The ledger's lock (packages/sdk/src/ledger.ts acquire) tries one write on each new
// SQLite connection and wraps that write's error in a plain Error whose code sits only in `cause`, so diskError sees
// no code and the command ends "Unexpected error (Error)" with no next action (FLOWS.md, Recovery: "Every error row
// has one next action"). r30's own test (buyer.test.ts, "the data folder refuses writes") covers a read-only
// ~/.attessa with no pending.lock yet, where the open itself fails unwrapped. Every buyer who has made one call has
// that file, and then the same read-only folder reaches the wrapped path. The world is adversary-t21-r30.test.ts's.

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

async function service(chain: FakeChain, agent: bigint) {
  const rnd = () => privateKeyToAccount(generatePrivateKey());
  const operator = rnd().address.toLowerCase() as Address;
  const payTo = rnd().address.toLowerCase() as Address;
  const enclave = rnd();
  const releaseId = keccak256(stringToBytes(`release-${Math.random()}`));
  chain.approveRelease(agent, releaseId, SOURCE);
  const gw = new FakeGateway(chain, { agentId: agent, releaseId, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(agent, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, agent, releaseId, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  return { gw, origin, payTo };
}

async function buyerWorld() {
  const chain = new FakeChain({ startTime: 1_793_000_000n, startBlock: 31_204_000n });
  const s1 = await service(chain, 412n);
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-cli-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    s1,
    home,
    cwd: home,
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
        cwd: w.cwd,
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
    async close() {
      if (existsSync(join(home, '.attessa'))) chmodSync(join(home, '.attessa'), 0o700);
      await s1.gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  for (const [f, amount] of [
    ['tx1.json', '20000'],
    ['tx2.json', '30000'],
  ] as const) {
    writeFileSync(join(home, f), JSON.stringify({ chainId: String(chain.chainId), payTo: s1.payTo, asset: chain.asset, amount }));
  }
  return w;
}

let w: Awaited<ReturnType<typeof buyerWorld>>;
afterEach(async () => w?.close());

const LOCAL = ['--network', 'local', '--rpc', 'http://127.0.0.1:1'];

/** init, one verified call (it leaves pending.lock, as any first call does), then ~/.attessa turns read-only. */
async function afterFirstCall() {
  w = await buyerWorld();
  expect(await w.cli('init')).toBe(0);
  expect(await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx1.json', ...LOCAL)).toBe(0);
  expect(existsSync(join(w.home, '.attessa', 'pending.lock'))).toBe(true);
  chmodSync(join(w.home, '.attessa'), 0o500);
  w.out.length = 0;
}

describe('T21 adversary r31: a read-only data folder after the first call', () => {
  it('attessa call ends disk_write_failed with its next action, not an unexpected error', async () => {
    await afterFirstCall();
    const code = await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx2.json', '--json', ...LOCAL);
    expect(code).toBe(1);
    const result = JSON.parse(w.out.at(-1)!) as { error: string; message: string; next: string | null };
    expect(result, `json: ${JSON.stringify(result)}`).toMatchObject({ error: 'disk_write_failed', next: expect.any(String) });
  }, 60_000);

  it("attessa status --pending, the r30 row's own next action, ends disk_write_failed too", async () => {
    await afterFirstCall();
    const code = await w.cli('status', '--pending', '--json', ...LOCAL);
    expect(code).toBe(1);
    const result = JSON.parse(w.out.at(-1)!) as { error: string; message: string; next: string | null };
    expect(result, `json: ${JSON.stringify(result)}`).toMatchObject({ error: 'disk_write_failed', next: expect.any(String) });
  }, 60_000);
});
