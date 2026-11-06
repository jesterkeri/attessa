import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOYMENTS, originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// Adversary T21 r35: a USA₮ call on a Celo mainnet fork (`--network local`, chain 42220, the pinned USA₮ token from
// @attessa/core DEPLOYMENTS.celo) is interrupted after signing and settles. Re-running the same command with the same
// input resumes that call (FLOWS §6 "Resuming it instead of paying again"), but without `--asset usat` this time.
// The ledger entry, the evidence row and --json all name the USA₮ token; the human lines must name it too.

const AGENT = 412n;
const SOURCE = 'https://github.com/acme/risk/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const USAT = DEPLOYMENTS.celo.assets.usat!;

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
  const chain = new FakeChain({
    chainId: DEPLOYMENTS.celo.chainId,
    asset: USAT.address as Address,
    tokenName: USAT.name,
    tokenVersion: USAT.version,
    startTime: 1_793_000_000n,
    startBlock: 31_204_000n,
  });
  const rnd = () => privateKeyToAccount(generatePrivateKey());
  const operator = rnd().address.toLowerCase() as Address;
  const payTo = rnd().address.toLowerCase() as Address;
  const enclave = rnd();
  const r1 = keccak256(stringToBytes(`release-r1-${Math.random()}`));
  chain.approveRelease(AGENT, r1, SOURCE);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId: r1, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, r1, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv35-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    home,
    url: `${origin}/v1/evaluate`,
    transcript: [] as string[],
    json: [] as unknown[],
    deps(): Deps {
      return {
        io: { out: (l) => void w.transcript.push(l), err: (l) => void w.transcript.push(l), confirm: async () => true, data: (x) => void w.json.push(x) },
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
    evidence(): Array<Record<string, unknown>> {
      const p = join(home, '.attessa', 'evidence.jsonl');
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    async close() {
      await gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, 'tx.json'), JSON.stringify({ chainId: String(chain.chainId), payTo, asset: chain.asset, amount: '20000' }));
  expect(await w.cli('init', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
  w.transcript.length = 0;
  return w;
}

let w: Awaited<ReturnType<typeof world>> | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('T21 adversary r35: a resumed USA₮ call is reported in the asset that was paid', () => {
  it('re-running without --asset resumes the USA₮ call and says USA₮, not USDC (FLOWS J1 "Paid {p} {sym}")', async () => {
    w = await world();
    // First run: USA₮, the connection drops after the gateway settled; --no-wait leaves the call open.
    w.gw.behavior = { paid: 'drop_after_settle' };
    expect(await w.call('--asset', 'usat', '--no-wait')).toBe(1);
    // Second run, same command and input but without --asset: V0 resumes the open USA₮ call (no second payment).
    w.gw.behavior = {};
    w.transcript.length = 0;
    w.json.length = 0;
    expect(await w.call()).toBe(0);
    const t = w.transcript.join('\n');
    expect(t).toContain('Resuming it instead of paying again');
    // Only one payment permission was ever sent to the gateway: this run resumed, it didn't pay again.
    expect(w.gw.paid.length).toBe(1);
    // The record and --json say the USA₮ token was paid.
    const row = w.evidence().find((r) => r.outcome === 'verified');
    expect(row?.asset).toBe(USAT.address.toLowerCase());
    // So the line that tells the buyer what they paid must name USA₮ too.
    const paidLine = w.transcript.find((l) => l.startsWith('Paid ') || l.startsWith('Charged '));
    expect(paidLine).toBeDefined();
    expect(paidLine).toContain('0.02 USA₮');
    expect(paidLine).not.toContain('USDC');
  });
});
