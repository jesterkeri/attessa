import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOYMENTS, originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeChain } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// T21 adversary r33. The buyer commands with no EnclaveRegistry address known for the network. Both pinned
// deployments have `enclaveRegistry: null` until T10 / T30 (packages/core/src/deployments.ts:41,52), and the buyer's
// makeClient passes ATTESSA_REGISTRY only when it is set (packages/cli/src/commands/buyer.ts:218). Without it the
// SDK's net() throws a plain Error, not an AttestError ("no EnclaveRegistry is deployed for chain ...",
// packages/sdk/src/client.ts:244), so:
// - `attessa call` and `attessa status --pending` end on run()'s "Unexpected error (Error)" row with `next` null
//   (packages/cli/src/index.ts:234). FLOWS.md:832 (§9 Recovery): "Every error row has one next action". The seller
//   commands already have the row for this exact case, ERR.noRegistry, with its next action "Set ATTESSA_REGISTRY to
//   the registry address." (packages/cli/src/copy.ts:235, used by context.ts:135).
// - `attessa status <origin>` maps every failure of its read to the rpc_unavailable row (buyer.ts:708), so it says
//   "Can't reach Celo at {rpc}." about an RPC that just answered eth_chainId: a false statement, and its next action
//   ("Retry or set another `--rpc`.") can never work.
// Trigger: Celo Sepolia (chain 11142220; here --network local on it, as the fake gateway is http) with ATTESSA_REGISTRY unset. The world is
// adversary-t21-r32.test.ts's (FakeChain on chain 11142220, one honest FakeGateway), without ATTESSA_REGISTRY.

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
    env: {} as Record<string, string | undefined>, // ATTESSA_REGISTRY unset
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

// The fake gateway serves http://127.0.0.1, which only --network local accepts; on chain 11142220 that is a fork of
// Celo Sepolia, so deploymentForChainId gives Sepolia's pins, enclaveRegistry null included.
const LOCAL = ['--network', 'local', '--rpc', 'http://127.0.0.1:1'];

type JsonErr = { ok: boolean; error: string; message: string; next: string | null };

// Since the staging merge (T10) Sepolia has a pinned registry, so this world needs a chain with none (mainnet until T30):
// the Sepolia entry is unpinned for each test here and restored after.
const sepolia = DEPLOYMENTS['celo-sepolia'] as { enclaveRegistry: string | null };
const pinned = sepolia.enclaveRegistry;
beforeEach(() => void (sepolia.enclaveRegistry = null));
afterEach(() => void (sepolia.enclaveRegistry = pinned));

describe('T21 adversary r33: buyer commands on a network whose EnclaveRegistry address is not known', () => {
  it('attessa call: a row with one next action (FLOWS §9 Recovery), not "Unexpected error" with none', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    w.out.length = 0;
    const code = await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx1.json', ...LOCAL, '--json');
    const res = JSON.parse(w.out.at(-1)!) as JsonErr;
    // Preconditions: stopped before anything was signed.
    expect(code).toBe(1);
    expect(w.pending()).toEqual([]);
    expect(res.ok).toBe(false);
    // The defect: the unexpected-error row, with no next action.
    expect(res.error, `message: ${res.message}`).not.toBe('unexpected');
    expect(res.next, `message: ${res.message}`).not.toBeNull();
  }, 60_000);

  it('attessa status --pending: a row with one next action, not "Unexpected error" with none', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    w.err.length = 0;
    const code = await w.cli('status', '--pending', ...LOCAL);
    expect(code).toBe(1);
    // Human output: the what-happened line, then its one next action on its own line (index.ts:238-239).
    expect(w.err.length, `stderr:\n${w.err.join('\n')}`).toBe(2);
  }, 60_000);

  it("attessa status <origin>: never \"Can't reach Celo\" about an RPC that answered", async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    w.out.length = 0;
    const code = await w.cli('status', w.s1.origin, ...LOCAL, '--json');
    const res = JSON.parse(w.out.at(-1)!) as JsonErr;
    expect(code).toBe(1);
    expect(res.ok).toBe(false);
    // The fake RPC is up (it answers eth_chainId 11142220); what is missing is the registry address.
    expect(res.message).not.toMatch(/Can't reach Celo/);
    expect(res.error).not.toBe('rpc_unavailable');
  }, 60_000);

  it('control: the same world and command with ATTESSA_REGISTRY set reads the endpoint (the RPC is reachable)', async () => {
    w = await buyerWorld();
    w.env.ATTESSA_REGISTRY = w.chain.registry;
    expect(await w.cli('init')).toBe(0);
    w.out.length = 0;
    const code = await w.cli('status', w.s1.origin, ...LOCAL, '--json');
    const res = JSON.parse(w.out.at(-1)!) as { ok: boolean; agentId?: string };
    expect(code).toBe(0);
    expect(res).toMatchObject({ ok: true, agentId: '412' });
  }, 60_000);
});
