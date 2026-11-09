import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { custom, keccak256, stringToBytes, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// Adversary T21 r4. Every key here is generated in-test; no real key is used.

const AGENT = 412n;
const SOURCE = 'https://github.com/acme/risk/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const RPC = 'http://127.0.0.1:1';

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
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv4-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    origin,
    url: `${origin}/v1/evaluate`,
    home,
    /** When true, every RPC request fails as an unreachable node would. */
    rpcDown: false,
    /** Count of /v1/results requests carrying a payer signature. */
    resultFetches: 0,
    out: [] as string[],
    err: [] as string[],
    transcript: [] as string[],
    env: { ATTESSA_REGISTRY: chain.registry } as Record<string, string | undefined>,
    deps(): Deps {
      const real = chain.transport();
      const transport = custom({
        request: async (args: { method: string; params?: unknown }) => {
          if (w.rpcDown) throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:1');
          return real({ chain: undefined, retryCount: 0 }).request(args as never);
        },
      });
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
        runner: { run: async () => ({ code: 1, stdout: '', stderr: '' }) },
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes('/v1/results/')) w.resultFetches++;
          return fetch(input, init);
        }) as typeof fetch,
        enclave: () => {
          throw new Error('unused');
        },
        readFile: (p) => readFileSync(p),
        writeFile: (p, d) => writeFileSync(p, d),
        exists: (p) => existsSync(p),
        readdir: (p) => readdirSync(p),
        sleep: async () => {},
        arch: 'x64',
        sdk: {
          transport,
          fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).includes('/v1/results/')) w.resultFetches++;
            return fetch(input, init);
          }) as typeof fetch,
          sleep: async (ms: number) => chain.advance(Math.max(1, ms / 1000)),
          receiptWaitMs: 2000,
          httpTimeoutMs: 5000,
        } as Deps['sdk'],
      };
    },
    cli: (...argv: string[]) => run(argv, w.deps()),
    call: (...extra: string[]) => run(['call', w.url, '--body', 'tx.json', '--network', 'local', '--rpc', RPC, ...extra], w.deps()),
    pending(): Array<Record<string, unknown>> {
      const p = join(home, '.attessa', 'pending.jsonl');
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    clear() {
      w.out.length = 0;
      w.err.length = 0;
      w.transcript.length = 0;
    },
    async close() {
      await gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, 'tx.json'), JSON.stringify({ chainId: String(chain.chainId), payTo, asset: chain.asset, amount: '20000' }));
  return w;
}

type W = Awaited<ReturnType<typeof world>>;
let w: W | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/** init, then one call left open (signed, never settled), as FLOWS §6 "J1 interrupted" leaves it. */
async function withOpenCall(): Promise<{ w: W; id: string }> {
  w = await world();
  expect(await w.cli('init', '--network', 'local', '--rpc', RPC)).toBe(0);
  w.gw.behavior = { paid: 'pending_no_settle' };
  expect(await w.call('--no-wait')).toBe(1);
  const id = w.pending()[0]!.requestId as string;
  expect(w.pending()[0]!.nonce).not.toBeNull();
  w.clear();
  return { w, id };
}

// Brief: 'The chain check must be on the real chain id, not on a network name a user can set.'
// FLOWS section 8 wrong network: 'Your RPC is on chain {x}; this registry is on {y}.' -> network_mismatch.
// --network mainnet with an RPC that reports Celo Sepolia is not a 42220 send, so the tag is irrelevant and the
// wrong-network row must win. cancel() decides on g.network === 'mainnet' before the SDK has verified the chain.
describe('adversary mainnet entry r2: the tag check follows the real chain id, not the --network label', () => {
  it('cancel --network mainnet against a Sepolia RPC with no tag reports network_mismatch, not no_attribution_tag', async () => {
    const { w, id } = await withOpenCall();
    delete w.env.LOOPS_ATTRIBUTION_TAG;
    expect(await w.cli('cancel', id, '--network', 'mainnet', '--rpc', RPC, '--yes', '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'network_mismatch' });
  });

  it('same, with a malformed tag', async () => {
    const { w, id } = await withOpenCall();
    w.env.LOOPS_ATTRIBUTION_TAG = 'Not A Tag!';
    expect(await w.cli('cancel', id, '--network', 'mainnet', '--rpc', RPC, '--yes', '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'network_mismatch' });
  });
});
