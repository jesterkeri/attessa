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

// T21 adversary r12. `attessa cancel <id>` on a call that is already decided reports the ledger's stored outcome
// through the same `report` a live call uses. For a verified call, the stored result (SDK getResult on a terminal
// entry) carries no response bytes and no signer, so the CLI overwrites `<id>.json`, the answer the first
// "Too late to cancel ... Fetching your answer." run saved there, with zero bytes, then builds the paid line from an
// undefined signer. The natural trigger is running the same `attessa cancel <id>` twice.
// SPEC §7 getResult "never re-pays", so that saved file is the buyer's only copy of what they paid for; FLOWS §8
// gives every row one next action, and a crash ("Unexpected error") is none of them.
// The world below is adversary-t21-r11.test.ts's, unchanged.

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

describe('attessa cancel re-run on a call the first cancel found paid (verified)', () => {
  it('keeps the saved answer and prints one true outcome', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    w.gw.behavior = { paid: 'pending' };
    w.gw.behavior.pendingPolls = 1000;
    expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--no-wait')).toBe(1);
    const id = w.pending()[0]!.requestId as Hex;
    w.gw.release(id);
    w.transcript.length = 0;
    expect(await w.cli('cancel', id, ...LOCAL, '--yes')).toBe(0);
    expect(w.transcript[0]).toMatch(/^Too late to cancel: the payment went through/);
    expect(w.transcript.at(-1)).toBe(`Answer saved to ${id}.json. Record: ~/.attessa/evidence.jsonl`);
    expect(w.pending()[0]).toMatchObject({ state: 'verified' });
    const answer = readFileSync(join(w.home, `${id}.json`));
    expect(answer.length).toBeGreaterThan(0);

    // The same command again (the user wasn't sure the first one worked).
    w.transcript.length = 0;
    const code = await w.cli('cancel', id, ...LOCAL, '--yes');
    expect(readFileSync(join(w.home, `${id}.json`)).toString()).toBe(answer.toString());
    expect(w.transcript.join('\n')).not.toMatch(/undefined|Unexpected error/);
    expect(code).toBe(0);
  }, 60_000);
});
