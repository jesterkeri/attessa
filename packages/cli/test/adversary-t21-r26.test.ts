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

// T21 adversary r26. evidence.jsonl is append-only (SDK ledger.ts appendEvidence: appendFileSync), so an append cut
// short (a full disk, as adversary-t21-r24 simulates, or the process killed mid-write) leaves a last line that is
// half a JSON row. Ledger.readEvidence JSON.parses every line and throws on that one. The SDK never reads evidence,
// so `attessa status --pending` still decides every open call (each becomes `verified`, terminal: getResult never
// re-fetches it, SPEC §7), but the CLI's report() reads evidence for the "Paid" line after writing each answer
// (buyer.ts lastEvidence). The SyntaxError is not a CliError, so status rethrows it: the first call's answer is
// written, and every later decided call's paid, verified answer is written nowhere. SPEC §9: the buyer paid for it.
// The world below is adversary-t21-r22.test.ts's.

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

describe('T21 adversary r26: an evidence.jsonl whose last append was cut short', () => {
  it('status --pending still keeps every decided call\'s paid, verified answer', async () => {
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
    // The state an append cut short leaves: the first half of the SDK's own last evidence row, no newline.
    const ev = join(w.home, '.attessa', 'evidence.jsonl');
    const rows = readFileSync(ev, 'utf8').trim().split('\n');
    const last = rows.at(-1)!;
    writeFileSync(ev, `${rows.slice(0, -1).join('\n')}\n${last.slice(0, Math.floor(last.length / 2))}`);
    // Both gateways (honest) now serve their answers.
    w.s1.gw.release(idA);
    w.s2.gw.release(idB);
    await w.cli('status', '--pending', ...LOCAL);
    // Precondition of the loss: both calls are decided (terminal, never fetched again).
    expect(w.pending().map((e) => e.state)).toEqual(['verified', 'verified']);
    const kept = (id: Hex) => existsSync(join(w.cwd, `${id}.json`)) || existsSync(join(w.home, '.attessa', `${id}.json`));
    expect(kept(idA), `answer for ${idA} written nowhere`).toBe(true);
    expect(kept(idB), `answer for ${idB} written nowhere`).toBe(true);
    // A later run can't get it back: the call is terminal.
  }, 60_000);
});
