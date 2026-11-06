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

// T21 adversary r29. The r28 fix routes every SDK evidence write through appendOrMark, which marks the CallResult
// `evidenceNotWritten`, and the CLI's report() ends such a result `record_not_written`. Two buyer paths miss it when
// evidence.jsonl can't be appended (here the file is read-only, EACCES; a full disk, ENOSPC, takes the same path):
// 1. `attessa cancel` that lands: cancelAuthorization's finish() marks a CallResult it then drops and returns only
//    the tx hash (client.ts:1209), so the CLI prints "Cancelled (tx ...)." and exits 0 with no row for the call in
//    the record and no record_not_written line (SPEC §9: every outcome is in evidence).
// 2. over_daily_cap: stoppedError reads the price back from the evidence row the SDK just failed to write
//    (buyer.ts:507), so it prints "this would take today's spend to 0.00 USDC" (FLOWS §8 over_daily_cap:
//    "Not paying: this would take today's spend to {s} USDC; your cap is {c}.").
// The world below is adversary-t21-r28.test.ts's, plus an evidence() reader.

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
    evidence(): Array<Record<string, unknown>> {
      const p = join(home, '.attessa', 'evidence.jsonl');
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

describe('T21 adversary r29: buyer paths that miss a failed evidence append', () => {
  it('attessa cancel that lands while the record cannot be written ends record_not_written, never exit 0 silently', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    // Honest gateway refuses after signing; --no-wait leaves the call open for the buyer to cancel (buyer.test.ts:444).
    w.s1.gw.behavior = { paid: 'refuse' };
    expect(await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx1.json', '--no-wait', ...LOCAL)).toBe(1);
    const id = w.pending()[0]!.requestId as string;
    const ev = join(w.home, '.attessa', 'evidence.jsonl');
    expect(existsSync(ev)).toBe(true);
    chmodSync(ev, 0o444);
    w.transcript.length = 0;
    w.err.length = 0;
    const code = await w.cli('cancel', id, ...LOCAL, '--yes');
    // Preconditions: the cancel landed and the call is decided, but no not_charged row for it reached the record.
    expect(w.pending()[0]).toMatchObject({ state: 'not_charged', code: 'cancelled' });
    expect(w.evidence().filter((r) => r.requestId === id && r.outcome === 'not_charged')).toEqual([]);
    // The defect: the missing record is never said, and the command exits 0.
    expect(w.err, `transcript:\n${w.transcript.join('\n')}`).toContain(`Couldn't add this call to your record at ~/.attessa/evidence.jsonl.`);
    expect(code).toBe(1);
  }, 60_000);

  it('over_daily_cap names the real spend when the record cannot be written, not 0.00', async () => {
    w = await buyerWorld();
    expect(await w.cli('init', '--daily-cap', '0.01')).toBe(0);
    // Control: the record writes, so the row is FLOWS §8 over_daily_cap with the quoted price.
    expect(await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx1.json', ...LOCAL)).toBe(1);
    const control = w.err.find((l) => l.startsWith('Not paying: this would take'));
    expect(control, `transcript:\n${w.transcript.join('\n')}`).toBeDefined();
    expect(control).not.toContain('to 0.00 USDC');
    // Same call, same spend (over_daily_cap reserves nothing), but evidence.jsonl now refuses the append.
    chmodSync(join(w.home, '.attessa', 'evidence.jsonl'), 0o444);
    w.err.length = 0;
    expect(await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx1.json', ...LOCAL)).toBe(1);
    const attacked = w.err.find((l) => l.startsWith('Not paying: this would take'));
    expect(attacked).toBe(control);
  }, 60_000);
});
