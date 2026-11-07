import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

// T21 adversary r27. The SDK's finish() (client.ts:383) moves the ledger entry to its terminal state first
// (ledger.update, client.ts:403) and only then appends the evidence row (client.ts:413 -> ledger.ts:176). When that
// append throws (ENOSPC, EFBIG, EACCES on evidence.jsonl), payAndVerify throws with the entry already `verified`: the
// paid, verified answer is in no CallResult, the CLI never writes it, and getResult on a terminal entry never
// fetches it again (SPEC §7), so a later run cannot get it back. SPEC §7 V12 lists "Evidence row; ...; ledger entry
// terminal"; SPEC §9 success guarantee is "response + verified proof + chain-confirmed settlement".
// The failing append is a real kernel ENOSPC: evidence.jsonl is a link to /dev/full, the rest of the folder writes.
// The world below is adversary-t21-r26.test.ts's, with one service.

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

describe('T21 adversary r27: the evidence append fails after the call is decided', () => {
  it('a paid, verified answer is still written, now or by a later run', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    const ev = join(w.home, '.attessa', 'evidence.jsonl');
    expect(existsSync(ev)).toBe(false);
    // Only the evidence append fails (a real ENOSPC from the kernel); pending.jsonl, result.json and the kept file write.
    symlinkSync('/dev/full', ev);
    const code = await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx1.json', ...LOCAL);
    const [entry] = w.pending();
    const id = entry!.requestId as Hex;
    // Precondition of the loss: the call was paid and is decided (terminal, never fetched again).
    expect(entry!.state).toBe('verified');
    expect(entry!.settlementTx).toMatch(/^0x[0-9a-f]{64}$/);
    // The disk is freed; the buyer runs the command that decides and reports open calls.
    unlinkSync(ev);
    await w.cli('status', '--pending', ...LOCAL);
    const kept = existsSync(join(w.cwd, 'result.json')) || existsSync(join(w.cwd, `${id}.json`)) || existsSync(join(w.home, '.attessa', `${id}.json`));
    expect(kept, `paid answer for ${id} written nowhere (call exit ${code}); transcript:\n${w.transcript.join('\n')}`).toBe(true);
  }, 60_000);
});
