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

// T21 adversary r32. Both ways the SDK stops a call with `network_mismatch` before anything is signed, other than
// the RPC's chain id, reach the CLI's fallback in sdkError (packages/cli/src/commands/buyer.ts:531): its detail
// doesn't match /^RPC is on chain (\d+); \S+ is (\d+)$/, so the row is `Wrong network: {detail}. Nothing was
// signed.` with `next` null. FLOWS.md:832 (§9 Recovery): "Every error row has one next action"; FLOWS §8's
// network_mismatch row has one ("Set `--rpc` for {y}.", suggestion `set_rpc`), and FLOWS §7 names this case:
// "A quote whose network ≠ configured → `network_mismatch`." The two triggers:
// 1. `attessa call --asset usat` on Celo Sepolia (SPEC §8 lists `--asset usdc|usat`; Sepolia pins no USA₮), so
//    pinFor throws network_mismatch "usat is not offered on chain 11142220" (packages/sdk/src/client.ts:252).
// 2. A quote whose only entry names another network (SPEC §7 V3; packages/sdk/src/x402.ts:87).
// The world is adversary-t21-r29.test.ts's (FakeChain on chain 11142220, one honest FakeGateway).

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
    pending(): Array<Record<string, unknown>> {
      const p = join(home, '.attessa', 'pending.jsonl');
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    async close() {
      await s1.gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, 'tx1.json'), JSON.stringify({ chainId: String(chain.chainId), payTo: s1.payTo, asset: chain.asset, amount: '20000' }));
  return w;
}

let w: Awaited<ReturnType<typeof buyerWorld>>;
afterEach(async () => w?.close());

const LOCAL = ['--network', 'local', '--rpc', 'http://127.0.0.1:1'];

describe('T21 adversary r32: a network_mismatch stop that is not the RPC chain id ends with no next action', () => {
  it('attessa call --asset usat on Celo Sepolia: the stop row has one next action (FLOWS §9 Recovery)', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    const code = await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx1.json', '--asset', 'usat', ...LOCAL, '--json');
    const res = JSON.parse(w.out.at(-1)!) as { ok: boolean; error: string; message: string; next: string | null };
    // Preconditions: stopped before anything was signed, as network_mismatch.
    expect(code).toBe(1);
    expect(w.pending()).toEqual([]);
    expect(res).toMatchObject({ ok: false, error: 'network_mismatch' });
    // The defect: no next action.
    expect(res.next, `message: ${res.message}`).not.toBeNull();
  }, 60_000);

  it('a quote on another network (FLOWS §7 "A quote whose network ≠ configured"): the stop row has one next action', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    w.s1.gw.behavior = {
      quote: (pr) => {
        (pr.accepts as Array<Record<string, unknown>>)[0]!.network = 'eip155:42220';
      },
    };
    w.err.length = 0;
    const code = await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx1.json', ...LOCAL);
    expect(code).toBe(1);
    expect(w.pending()).toEqual([]);
    // Human output: the what-happened line, then its one next action (index.ts prints `next` on its own line).
    expect(w.err[0]).toMatch(/network/i);
    expect(w.err.length, `stderr:\n${w.err.join('\n')}`).toBe(2);
  }, 60_000);
});
