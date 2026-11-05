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

// T21 adversary r56. `attessa status` never shows the buyer agent's spend today against its daily cap.
//
// FLOWS.md:881 (Legibility): "Human oversight of the buyer agent: `attessa status` shows spend today vs cap, pending
//   authorizations, and recent verdicts. The cap is the governor."
// FLOWS.md:851 (Web3 checklist): "The buyer agent's delegated spending is bounded, readable and revocable: maxAmount
//   per call, dailyCap per day, validBefore <= 120 s, all in USDC units, shown by `attessa status`."
//
// Bare `attessa status` runs the `--pending` branch (buyer.ts status(): `o.target === undefined || o.pending`), which
// prints only reconciled calls or "No calls in progress." After a verified 0.02 USDC call under J0's default limits
// (0.10 per call, 1.00 per day) nothing it prints, and nothing in its --json, names the 0.02 spent or the 1.00 cap.

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
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv-r56-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    home,
    keychain,
    url: `${origin}/v1/evaluate`,
    out: [] as string[],
    err: [] as string[],
    data: [] as Array<Record<string, unknown>>,
    deps(): Deps {
      return {
        io: { out: (l) => void w.out.push(l), err: (l) => void w.err.push(l), confirm: async () => true, data: (f) => void w.data.push(f) },
        env: { ATTESSA_REGISTRY: chain.registry },
        cwd: home,
        home,
        keychain,
        rpc: () => {
          throw new Error('unused');
        },
        runner: { run: async () => ({ code: 1, stdout: '', stderr: '' }) },
        fetch,
        enclave: () => {
          throw new Error('unused');
        },
        readFile: (p) => readFileSync(p),
        writeFile: (p, d) => writeFileSync(p, d),
        exists: (p) => existsSync(p),
        readdir: (p) => readdirSync(p),
        sleep: async () => {},
        arch: 'x64',
        sdk: { transport: chain.transport(), sleep: async (ms: number) => chain.advance(Math.max(1, ms / 1000)), receiptWaitMs: 2000, httpTimeoutMs: 5000 },
      };
    },
    cli: (...argv: string[]) => run(argv, w.deps()),
    call: (...extra: string[]) => run(['call', w.url, '--body', 'tx.json', '--network', 'local', '--rpc', 'http://127.0.0.1:1', ...extra], w.deps()),
    pending(): Array<Record<string, unknown>> {
      const p = join(home, '.attessa', 'pending.jsonl');
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    reset() {
      w.out.length = 0;
      w.err.length = 0;
      w.data.length = 0;
    },
    async close() {
      await gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, 'tx.json'), JSON.stringify({ chainId: String(chain.chainId), payTo, asset: chain.asset, amount: '20000' }));
  expect(await w.cli('init', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
  w.reset();
  return w;
}

let w: Awaited<ReturnType<typeof world>> | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('adversary T21 r56: attessa status shows spend today vs cap (FLOWS:881, FLOWS:851)', () => {
  it('after a verified 0.02 USDC call, plain `attessa status` names the 0.02 spent today and the 1.00 cap', async () => {
    w = await world();
    // The path under test: one verified call that spent 0.02 USDC today, under J0's default cap of 1.00.
    expect(await w.call()).toBe(0);
    expect(w.pending()[0]!.state).toBe('verified');
    w.reset();
    expect(await w.cli('status', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    const transcript = [...w.out, ...w.err];
    // FLOWS:881: some line puts today's spend (0.02) next to the cap (1.00).
    expect(
      transcript.filter((l) => /(^|[^\d.])0\.02(?![\d])/.test(l) && /(^|[^\d.])1\.00?(?![\d])/.test(l)),
      transcript.join('\n'),
    ).toHaveLength(1);
  });

  it("`attessa status --json` carries today's spend and the daily cap", async () => {
    w = await world();
    expect(await w.call()).toBe(0);
    w.reset();
    expect(await w.cli('status', '--json', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    // run() prints the one JSON object on stdout; its `lines` are the human lines, so drop them and keep the fields.
    const { lines: _lines, ...fields } = JSON.parse(w.out.at(-1)!) as Record<string, unknown>;
    const json = JSON.stringify(fields);
    // In USDC units (FLOWS:851) or atomic: 20000 spent, 1000000 cap. The verified row in `pending` carries the
    // call's amount, so look outside it.
    const { pending: _pending, ...top } = fields;
    const topJson = JSON.stringify(top);
    expect(topJson, json).toMatch(/"0\.02"|[^\d]20000[^\d]/);
    expect(topJson, json).toMatch(/"1\.00?"|[^\d]1000000[^\d]/);
  });
});

// Second lead, the r54 fix's other paths. FLOWS §8 "payment invalid": next action "Add at least {n} USDC to {address}."
// FLOWS.md:832 "Recovery | Every error row has one next action". buyer.ts call() passes `fund` only into report(), and
// reportOutcome prints it only for `not_charged`. With --no-wait the refused call ends on the open-call line, and the
// later `status --pending` (or a re-run `call`, V0) that decides it not charged has no `authorizing` event, so no price
// and no `fund`: the buyer is never told to fund the wallet.
describe('adversary T21 r56: payment_invalid{insufficient_funds} next action survives --no-wait', () => {
  function wallet(w: { keychain: MemKeychain }): string {
    const key = [...w.keychain.store.values()][0]!;
    return privateKeyToAccount(key as `0x${string}`).address.toLowerCase();
  }

  it('call --no-wait then status --pending: "Add at least {n} USDC to {address}." is printed at least once', async () => {
    w = await world();
    w.gw.behavior = { paid: 'refuse', refuseWith: { status: 402, error: 'payment_invalid', detail: 'insufficient_funds' } };
    expect(await w.call('--no-wait')).toBe(1);
    const first = [...w.out, ...w.err];
    expect(first).toContain('Not paid: the payment permission was refused because insufficient funds.');
    // Past validBefore + 5, so status --pending can decide it.
    w.chain.advance(200);
    await w.cli('status', '--pending', '--network', 'local', '--rpc', 'http://127.0.0.1:1'); // its exit code reports errors only (buyer.ts status())
    expect(w.pending()[0]!.state).toBe('not_charged');
    const transcript = [...w.out, ...w.err];
    const next = new RegExp(`^Add at least \\d+(?:\\.\\d+)? USDC to ${wallet(w)}\\.$`, 'i');
    expect(transcript.filter((l) => next.test(l)).length, transcript.join('\n')).toBeGreaterThan(0);
  });
});
