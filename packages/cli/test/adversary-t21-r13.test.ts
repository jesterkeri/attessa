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

// T21 adversary r13. The chain shows the payment permission was used (AuthorizationUsed + Transfer to payTo, the
// settlement tx recorded in the pending entry), but the gateway's /v1/results keeps answering 202, so no answer
// can be fetched yet. The SDK leaves the call `uncertain` with that settlementTx. The CLI's report() prints the
// open-call line for every `uncertain` without rpc_unavailable: "Not confirmed yet: your payment permission expires
// unused at {t} UTC ... attessa cancel {id} voids it now." That is false (the money moved, validBefore is already
// past) and its next action can't work (`cancel` then says "Too late to cancel").
// FLOWS §8 "interrupted, payment found": "The payment went through (tx {h}). Fetching your answer…"; FLOWS §7:
// "Refused, SettlePending and Uncertain resolve from chain state, never by guessing"; FLOWS §9: every error row
// has one next action, and a cancel of a settled permission is not one.
// The world below is adversary-t21-r12.test.ts's, unchanged.

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

const RPC = 'http://127.0.0.1:1';
const LOCAL = ['--network', 'local', '--rpc', RPC];

describe('a call the chain shows settled, its answer not served yet', () => {
  it('attessa status --pending never says the permission may expire unused or that cancel voids it', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    w.gw.behavior = { paid: 'pending' };
    w.gw.behavior.pendingPolls = 100_000; // /v1/results keeps answering 202
    expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--no-wait')).toBe(1);
    const id = w.pending()[0]!.requestId as Hex;

    w.transcript.length = 0;
    expect(await w.cli('status', '--pending', ...LOCAL)).toBe(0);
    const tx = w.pending()[0]!.settlementTx as string;
    // Precondition: the SDK found the settlement on chain and recorded it.
    expect(tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.pending()[0]).toMatchObject({ requestId: id, state: 'uncertain' });

    const text = w.transcript.join('\n');
    expect(text).not.toMatch(/expires unused/);
    expect(text).not.toMatch(/voids it now/);
    expect(text).toContain(tx.slice(0, 6));
  }, 60_000);
});
