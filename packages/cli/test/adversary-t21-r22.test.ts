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

// T21 adversary r22. `attessa status <origin> --pending` with two open calls, one to each of two services, whose
// answers both arrive on this run. reconcilePending drives every open entry, so it fetches and verifies the other
// service's answer too and marks that entry `verified` (terminal: getResult never re-fetches it, SPEC §7). The CLI
// then filters the results down to <origin> and reports only those: the other call's paid, verified answer is
// written nowhere and its call is never reported. SPEC §9: every outcome is in evidence; the buyer paid for it.
// The world below is adversary-t21-r21.test.ts's, with a second service on the same chain.

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
  const s2 = await service(chain, 413n);
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-cli-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    s1,
    s2,
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
    pending(): Array<Record<string, unknown>> {
      const p = join(home, '.attessa', 'pending.jsonl');
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    async close() {
      await s1.gw.stop();
      await s2.gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, 'tx1.json'), JSON.stringify({ chainId: String(chain.chainId), payTo: s1.payTo, asset: chain.asset, amount: '20000' }));
  writeFileSync(join(home, 'tx2.json'), JSON.stringify({ chainId: String(chain.chainId), payTo: s2.payTo, asset: chain.asset, amount: '20000' }));
  return w;
}

let w: Awaited<ReturnType<typeof buyerWorld>>;
afterEach(async () => w?.close());

const LOCAL = ['--network', 'local', '--rpc', 'http://127.0.0.1:1'];

describe('status <origin> --pending, answers arriving for two services', () => {
  it("the other service's paid, verified answer is not consumed and dropped by a status scoped to one origin", async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    // One call to each service, both settled on chain, /v1/results answering 202 for now.
    w.s1.gw.behavior = { paid: 'pending', pendingPolls: 100_000 };
    w.s2.gw.behavior = { paid: 'pending', pendingPolls: 100_000 };
    expect(await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx1.json', ...LOCAL, '--no-wait')).toBe(1);
    expect(await w.cli('call', `${w.s2.origin}/v1/evaluate`, '--body', 'tx2.json', ...LOCAL, '--no-wait')).toBe(1);
    const [a, b] = w.pending();
    const idA = a!.requestId as Hex;
    const idB = b!.requestId as Hex;
    expect(idA).not.toBe(idB);
    // Both gateways (honest) now serve their answers.
    w.s1.gw.release(idA);
    w.s2.gw.release(idB);
    w.out.length = 0;
    w.err.length = 0;
    w.transcript.length = 0;
    // The buyer asks about the first service only.
    await w.cli('status', w.s1.origin, '--pending', ...LOCAL);
    // The asked-about call is reported and its answer written.
    expect(existsSync(join(w.cwd, `${idA}.json`))).toBe(true);
    // Precondition of the loss: the scoped run decided the other service's call too (terminal, never re-fetched).
    expect(w.pending().find((e) => e.requestId === idB)!.state).toBe('verified');
    // Then a full `status --pending`: whichever way a fix goes (leave the other call open, or keep its answer), the
    // buyer must end up with the other service's paid, verified answer somewhere.
    await w.cli('status', '--pending', ...LOCAL);
    const answerKept = existsSync(join(w.cwd, `${idB}.json`)) || existsSync(join(w.home, '.attessa', `${idB}.json`));
    expect(answerKept, `answer for ${idB} written nowhere`).toBe(true);
  }, 60_000);
});
