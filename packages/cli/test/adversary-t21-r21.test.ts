import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// T21 adversary r21. `attessa status --pending` with two open calls whose answers both arrive on this run, from a
// working folder that can't take the per-call answer file. reconcilePending marks both entries `verified` (terminal:
// getResult never re-fetches them, SPEC §7) before report() runs. report() on the first call keeps its answer in the
// data folder and throws answer_not_written, which ends the loop: the second call's paid, verified answer is written
// nowhere and its lines never print. SPEC §9: every outcome is in evidence; the buyer paid for both answers.
// The world below is adversary-t21-r20.test.ts's, with a switchable cwd.

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
    cwd: home,
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

describe('status --pending, two answers arriving, working folder unwritable', () => {
  it("the second call's paid, verified answer is kept and reported, not lost when the first one's file can't be written", async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    // Two calls, both settled on chain, /v1/results answering 202 for now.
    w.gw.behavior = { paid: 'pending', pendingPolls: 100_000 };
    expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--no-wait')).toBe(1);
    expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--no-wait', '--new')).toBe(1);
    const [a, b] = w.pending();
    const idA = a!.requestId as Hex;
    const idB = b!.requestId as Hex;
    expect(idA).not.toBe(idB);
    // The gateway's reconciler catches up: both answers are served now (an honest gateway).
    w.gw.release(idA);
    w.gw.release(idB);
    // The folder status runs from is gone (a removed temp dir): `<requestId>.json` can't be written there.
    w.cwd = join(w.home, 'gone');
    w.out.length = 0;
    w.err.length = 0;
    w.transcript.length = 0;
    await w.cli('status', '--pending', ...LOCAL);
    const after = w.pending();
    // Preconditions: both entries are terminal now, so nothing will fetch either answer again.
    expect(after.find((e) => e.requestId === idA)!.state).toBe('verified');
    expect(after.find((e) => e.requestId === idB)!.state).toBe('verified');
    // The first answer is kept beside the record (the r19 fix).
    expect(existsSync(join(w.home, '.attessa', `${idA}.json`))).toBe(true);
    // The second paid, verified answer must be kept too, and its call reported.
    expect(w.transcript.join('\n')).toContain(idB);
    expect(existsSync(join(w.home, '.attessa', `${idB}.json`))).toBe(true);
  }, 60_000);
});
