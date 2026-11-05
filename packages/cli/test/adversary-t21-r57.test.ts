import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOYMENTS, originHash } from '@attessa/core';
import { spendToday, type Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// T21 adversary r57. `attessa status` adds another network's spend into the daily-cap line it shows.
//
// SPEC.md §7 (line 604): "Today's spend = sum of `amount` over entries in reserved|signed|refused|uncertain|settle_pending
//   plus every settled outcome, per asset." SPEC.md:627 V6: "today's (settled + reserved) for this asset + amount <=
//   dailyCap". FLOWS.md:881: "`attessa status` shows spend today vs cap ... The cap is the governor."
//
// The data folder (~/.attessa) is one per user, not one per network, and `--network` picks the chain per command. The
// cap `call` enforces (ledger.ts reserve -> spendToday(kept, entry.asset)) counts only the asset address of the network
// the call runs on. buyer.ts spendLines() instead sums every asset address that assetOf() maps to "usdc", so Celo
// mainnet USDC (0xceba...) and Celo Sepolia USDC (0x01c5...) are added into one "USDC" figure. The line then reports a
// spend the cap does not count: here "1.01 of your 1.00 USDC daily cap" on the network where only 0.02 was spent,
// and the very next call on that network is paid and verified.

const AGENT = 412n;
const SOURCE = 'https://github.com/acme/risk/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const MAINNET_USDC = DEPLOYMENTS.celo.assets.usdc.address.toLowerCase() as Address;

class MemKeychain implements Keychain {
  store = new Map<string, string>();
  async getPassword(s: string, a: string) {
    return this.store.get(`${s}/${a}`) ?? null;
  }
  async setPassword(s: string, a: string, p: string) {
    this.store.set(`${s}/${a}`, p);
  }
}

async function world(source = SOURCE) {
  const chain = new FakeChain({ startTime: 1_793_000_000n, startBlock: 31_204_000n }); // Celo Sepolia id and USDC
  const rnd = () => privateKeyToAccount(generatePrivateKey());
  const operator = rnd().address.toLowerCase() as Address;
  const payTo = rnd().address.toLowerCase() as Address;
  const enclave = rnd();
  const releaseId = keccak256(stringToBytes(`release-${Math.random()}`));
  chain.approveRelease(AGENT, releaseId, source);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, releaseId, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv-r57-'));
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
    pendingPath: join(home, '.attessa', 'pending.jsonl'),
    pending(): Array<Record<string, unknown>> {
      const p = w.pendingPath;
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

describe('adversary T21 r57: status spend line counts only what the cap on this network counts (SPEC §7 "per asset")', () => {
  it('a mainnet USDC call settled today is not added to the Sepolia USDC spend shown against the cap', async () => {
    w = await world();
    // 0.02 USDC verified on this network (the fake chain is Celo Sepolia: chain id 11142220, USDC 0x01c5...).
    expect(await w.call()).toBe(0);
    const [here] = w.pending();
    expect(here!.state).toBe('verified');
    expect(here!.asset).toBe(w.chain.asset);

    // The same data folder also holds a Celo mainnet call verified today for 0.99 USDC (`attessa call --network
    // mainnet`, same ~/.attessa). Same entry shape, the mainnet USDC address, a fresh requestId.
    const mainnet = {
      ...here!,
      requestId: keccak256(stringToBytes('r57-mainnet-call')),
      asset: MAINNET_USDC,
      amount: '990000',
      settlementTx: keccak256(stringToBytes('r57-mainnet-settlement')),
      createdAt: String(Date.now()),
    };
    appendFileSync(w.pendingPath, `${JSON.stringify(mainnet)}\n`);

    // What the cap governs on this network (ledger.ts reserve: spendToday(kept, entry.asset)): 0.02 only.
    expect(spendToday(w.pending() as never, w.chain.asset, Date.now())).toBe(20000n);

    w.reset();
    expect(await w.cli('status', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    const spentLines = [...w.out, ...w.err].filter((l) => l.startsWith('Spent today:'));
    // The cap's own figure for this network; the line printed is "Spent today: 1.01 of your 1.00 USDC daily cap".
    expect(spentLines, [...w.out, ...w.err].join('\n')).toEqual(['Spent today: 0.02 of your 1.00 USDC daily cap (at most 0.10 per call). It resets at 00:00 UTC.']);
  });

  it('--json limits.usdc.spentToday matches the cap on this network, and the next call is paid under that cap', async () => {
    w = await world();
    expect(await w.call()).toBe(0);
    const [here] = w.pending();
    appendFileSync(
      w.pendingPath,
      `${JSON.stringify({ ...here!, requestId: keccak256(stringToBytes('r57-mainnet-call-2')), asset: MAINNET_USDC, amount: '990000', createdAt: String(Date.now()) })}\n`,
    );
    w.reset();
    expect(await w.cli('status', '--json', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    const shown = (JSON.parse(w.out.at(-1)!) as { limits: { usdc: { spentToday: string; dailyCap: string } } }).limits.usdc;

    // The cap is the governor (FLOWS:881): a further 0.02 call on this network goes through, which a spend of
    // `shown.spentToday` against `shown.dailyCap` would refuse.
    w.reset();
    expect(await w.call('--new')).toBe(0);
    expect(w.pending().filter((e) => e.state === 'verified' && e.asset === w!.chain.asset)).toHaveLength(2);
    expect(shown.spentToday, JSON.stringify(shown)).toBe('0.02');
  });
});

// Second lead. `attessa evidence export` (csv is the default, printed to stdout) writes the seller's on-chain
// sourceRef into the ownerClaimedSource cell as is. csvCell() quotes a cell with CR or LF and guards = + - @, but
// leaves ESC and the other C0/C1 controls, so a release approved with "\r\x1b[2K..." rewrites the buyer's terminal
// line while the evidence is shown. Every other path escapes that string (copy.ts safe(), claimLabel(); r1 test
// "the owner-claimed source never reaches the terminal with control characters").
describe('adversary T21 r57: evidence export never prints the seller-written source with terminal control characters', () => {
  it('evidence export --format csv escapes ESC in ownerClaimedSource', async () => {
    w = await world('github.com/acme/risk@a1b2c3d\r\x1b[2KOwner build verified by attessa \x1b[8m');
    expect(await w.call()).toBe(0);
    w.reset();
    expect(await w.cli('evidence', 'export', '--format', 'csv')).toBe(0);
    const bad = [...w.out, ...w.err].filter((l) => /[\x1b\x9b]/.test(l));
    expect(bad.map((l) => JSON.stringify(l))).toEqual([]);
  });
});
