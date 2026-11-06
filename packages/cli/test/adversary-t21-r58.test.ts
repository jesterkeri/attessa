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

// T21 adversary r58.
//
// First lead. Plain `attessa status` reports a per-call limit that `attessa call` does not have.
//
// FLOWS.md:851: "The buyer agent's delegated spending is bounded, readable and revocable: maxAmount per call, dailyCap
//   per day, ... shown by `attessa status`." FLOWS.md:881: "`attessa status` shows spend today vs cap ... The cap is
//   the governor." FLOWS.md:788 (no spending limit configured): "No per-call limit is set, so nothing was signed."
//
// A buyer whose key is in ATTESSA_PRIVATE_KEY (FLOWS §6 J0 "Existing key") and who never saved limits with `attessa
// init` has no per-call limit: buyer.ts limitsFor() refuses every `call` without --max-amount (max_amount_required).
// buyer.ts spendLines() instead fills the missing limit from DEFAULT_LIMITS, so status says "(at most 0.10 per call)"
// and `--json` says `maxAmountPerCall: "0.10"`, a bound that nothing enforces: the same buyer's `call --max-amount 5`
// is not held to 0.10. The oversight line misstates the limit an agent runs under.
//
// Second lead. `attessa evidence export --format jsonl` prints the seller's on-chain sourceRef with raw C1 and bidi
// controls. The r57 fix escapes them for csv (csvCell -> safe(): "seller text (sourceRef) never reaches the terminal
// raw"); jsonl goes through JSON.stringify only, which escapes C0 but leaves U+0080 to U+009F (U+009B is CSI) and
// U+202E (RIGHT-TO-LEFT OVERRIDE) as they are. copy.ts safe() documents the rule this breaks: "C0 and C1 controls ...
// and Unicode's Bidi_Control set ... so a `\r`, an ANSI escape or a direction override can't overwrite or hide the
// text around it". JSON can carry them losslessly as \u009b / \u202e, so escaping costs no data.

const AGENT = 412n;
const SOURCE = 'https://github.com/acme/risk/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** Terminal-active characters (as adversary-t21-r2): C0/C1 controls except tab and LF, DEL, bidi controls. */
const ACTIVE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/;

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
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv-r58-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    home,
    keychain,
    env: { ATTESSA_REGISTRY: chain.registry } as Record<string, string | undefined>,
    url: `${origin}/v1/evaluate`,
    out: [] as string[],
    err: [] as string[],
    deps(): Deps {
      return {
        io: { out: (l) => void w.out.push(l), err: (l) => void w.err.push(l), confirm: async () => true },
        env: w.env,
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
    reset() {
      w.out.length = 0;
      w.err.length = 0;
    },
    async close() {
      await gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, 'tx.json'), JSON.stringify({ chainId: String(chain.chainId), payTo, asset: chain.asset, amount: '20000' }));
  return w;
}

let w: Awaited<ReturnType<typeof world>> | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('adversary T21 r58: plain status states only the per-call limit `call` enforces (FLOWS:851, :788)', () => {
  it('a buyer with ATTESSA_PRIVATE_KEY and no saved limits: call has no per-call limit, so status must not show 0.10', async () => {
    w = await world();
    w.env.ATTESSA_PRIVATE_KEY = generatePrivateKey(); // generated in-test; FLOWS J0 "Existing key"

    // What `call` says about this buyer's per-call limit: there is none (FLOWS §8 max_amount_required).
    expect(await w.call()).toBe(1);
    expect(w.err).toEqual([
      'No per-call limit is set, so nothing was signed.',
      'Run `attessa init` or pass --max-amount in USDC (for example --max-amount 0.05).',
    ]);

    // With --max-amount the agent pays; no 0.10 limit holds it (the price here is 0.02, the flag 5).
    w.reset();
    expect(await w.call('--max-amount', '5')).toBe(0);

    // What `attessa status` tells the human overseeing that agent.
    w.reset();
    expect(await w.cli('status', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    const spent = [...w.out, ...w.err].filter((l) => l.startsWith('Spent today:'));
    expect(spent, [...w.out, ...w.err].join('\n')).toHaveLength(1);
    expect(spent[0]).not.toContain('at most 0.10 per call');

    w.reset();
    expect(await w.cli('status', '--json', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    const json = JSON.parse(w.out.at(-1)!) as { limits: { usdc: { maxAmountPerCall?: string } } };
    expect(json.limits.usdc.maxAmountPerCall, JSON.stringify(json.limits)).not.toBe('0.10');
  });
});

describe('adversary T21 r58: evidence export --format jsonl never prints seller text with terminal controls', () => {
  it('a sourceRef holding U+009B (CSI) and U+202E (RLO) is not printed raw in the jsonl export', async () => {
    w = await world('github.com/acme/risk@a1b2c3d\u009b2K\u202eOwner build verified by attessa');
    expect(await w.cli('init', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    expect(await w.call()).toBe(0);

    // csv (r57 fix) escapes them.
    w.reset();
    expect(await w.cli('evidence', 'export', '--format', 'csv')).toBe(0);
    expect([...w.out, ...w.err].filter((l) => ACTIVE.test(l))).toEqual([]);

    // jsonl prints the same seller text to the same terminal.
    w.reset();
    expect(await w.cli('evidence', 'export', '--format', 'jsonl')).toBe(0);
    expect(w.out.length).toBeGreaterThan(0);
    const bad = [...w.out, ...w.err].filter((l) => ACTIVE.test(l));
    // Shown with each raw control spelled as <U+XXXX>, so the failure message itself stays readable.
    const shown = bad.map((l) => l.replace(new RegExp(ACTIVE.source, 'g'), (ch) => `<U+${ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}>`));
    expect(shown).toEqual([]);
  });
});
