import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

// T21 adversary r30. The r27 to r29 fixes cover an evidence.jsonl that can't be appended after money moved. The
// pending ledger has the same exposure and no guard: Ledger.write (ledger.ts:216) replaces pending.jsonl through
// `pending.jsonl.<pid>.tmp`, and settleAndVerify's first act on a delivered answer is ledger.update(settlementTx)
// (client.ts:554), outside any catch. When that write fails after the honest gateway settled and answered 200 (the
// disk filled during the call), payAndVerify throws ENOSPC and `attessa call` ends on "Unexpected error (Error,
// ENOSPC)" with no next action: the buyer was charged, the answer is dropped, and nothing says what to do next
// (FLOWS.md:832, Recovery: "Every error row has one next action").
// The failing write is a real kernel ENOSPC: the tmp path becomes a link to /dev/full once the payment settles, so
// the reservation and the signed entry (before it) were written normally. The world is adversary-t21-r29.test.ts's.

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

describe('T21 adversary r30: the pending ledger fails to write after money moved', () => {
  it('a paid, delivered call whose ledger write then hits a full disk ends on a row with a next action', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    // The disk fills once the honest gateway has settled: every later pending.jsonl write is a real ENOSPC.
    const tmp = join(w.home, '.attessa', `pending.jsonl.${process.pid}.tmp`);
    const settle = w.chain.settle.bind(w.chain);
    let settled = 0;
    w.chain.settle = ((...a: Parameters<typeof settle>) => {
      const h = settle(...a);
      settled++;
      symlinkSync('/dev/full', tmp);
      return h;
    }) as typeof settle;
    w.out.length = 0;
    w.err.length = 0;
    const code = await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx1.json', '--json', ...LOCAL);
    // Preconditions: the money moved, and the ledger still shows the call open, so status --pending can recover it.
    expect(settled).toBe(1);
    expect(w.pending()[0]).toMatchObject({ state: 'signed' });
    expect(code).toBe(1);
    const result = JSON.parse(w.out.at(-1)!) as { ok: boolean; error: string; message: string; next: string | null };
    // The defect: "Unexpected error" with no next action, after the buyer was charged and the answer arrived.
    expect(result.next, `json: ${JSON.stringify(result)}`).toEqual(expect.any(String));
  }, 60_000);
});
