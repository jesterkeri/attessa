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

// T21 adversary r19. `attessa call ... --out <file>` where the file can't be written (its folder doesn't exist).
// The call is paid and verified, and the SDK records the entry `verified` (terminal) before the CLI writes the answer.
// report() merges the verified result into --json, then d.writeFile throws: run() prints "Unexpected error" with no
// next action, and the --json object is an error merged with a verified result (`ok:false, error:'unexpected',
// next:null, outcome:'verified', settlementTx`). The paid answer is in no file, and getResult never re-fetches a
// terminal entry (SPEC §7 V12), so a later `attessa cancel <id>` says "It was saved when it arrived", which is false.
// FLOWS §9 Recovery: "Every error row has one next action"; SPEC §8 --json; FLOWS §6 J1 "Answer saved to {file}".
// The world below is adversary-t21-r18.test.ts's, unchanged.

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
const UNWRITABLE = 'no-such-dir/result.json';

describe('call --out to a file that cannot be written, after a verified payment', () => {
  it('the human error has one next action (FLOWS §9 Recovery), not "Unexpected error" alone', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    w.out.length = 0;
    w.err.length = 0;
    const code = await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--out', UNWRITABLE);
    // Preconditions: the payment settled and the call is recorded verified (terminal).
    expect(w.gw.paid).toHaveLength(1);
    expect(w.pending()[0]!.state).toBe('verified');
    expect(existsSync(join(w.home, UNWRITABLE))).toBe(false);
    expect(code).toBe(1);
    // The error the buyer sees after paying: a message and exactly one next action.
    expect(w.err[0]).not.toMatch(/^Unexpected error/);
    expect(w.err).toHaveLength(2);
  }, 60_000);

  it('--json: never an "unexpected" error object with no next action merged with a verified result', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    w.out.length = 0;
    await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--out', UNWRITABLE, '--json');
    expect(w.gw.paid).toHaveLength(1);
    const j = JSON.parse(w.out.at(-1)!) as Record<string, unknown>;
    expect({ ok: j.ok, error: j.error, outcome: j.outcome, hasNext: typeof j.next === 'string' && j.next.length > 0 }).not.toEqual({
      ok: false,
      error: 'unexpected',
      outcome: 'verified',
      hasNext: false,
    });
  }, 60_000);

  it('a later cancel never says the answer "was saved when it arrived" when no file was saved', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--out', UNWRITABLE);
    const id = w.pending()[0]!.requestId as string;
    expect(readdirSync(w.home).filter((f) => f.endsWith('.json') && f !== 'tx.json')).toEqual([]);
    w.out.length = 0;
    await w.cli('cancel', id, ...LOCAL, '--yes');
    expect(w.out.join('\n')).not.toContain('It was saved when it arrived');
  }, 60_000);
});
