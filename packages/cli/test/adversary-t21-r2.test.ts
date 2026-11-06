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
import { safe, sourceLabel } from '../src/copy.ts';
import { run } from '../src/index.ts';

// Adversary T21 r2: seller text that slips past safe(), and a private key echoed in an error message.

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

async function world(sourceRef = SOURCE) {
  const chain = new FakeChain({ startTime: 1_793_000_000n, startBlock: 31_204_000n });
  const rnd = () => privateKeyToAccount(generatePrivateKey());
  const operator = rnd().address.toLowerCase() as Address;
  const payTo = rnd().address.toLowerCase() as Address;
  const enclave = rnd();
  const releaseId = keccak256(stringToBytes(`release-${Math.random()}`));
  chain.approveRelease(AGENT, releaseId, sourceRef);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, releaseId, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv2-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    home,
    url: `${origin}/v1/evaluate`,
    transcript: [] as string[],
    deps(): Deps {
      return {
        io: { out: (l) => void w.transcript.push(l), err: (l) => void w.transcript.push(l), confirm: async () => true },
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

/** Terminal-active characters a seller must not get onto the buyer's screen raw: C0/C1 controls, DEL, bidi controls. */
const ACTIVE = /[\x00-\x08\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/;

describe('adversary T21 r2', () => {
  // KNOWN-LIMITS L20: sourceRef is the owner's unverified claim, so J1 prints it as "Owner says it's built from …
  // (not checked by attessa)" (FLOWS §6 J1). The seller writes sourceRef on chain. A GitHub-shaped sourceRef with
  // ESC[8m (conceal) inside the repo name still matches claimLabel's GitHub pattern, which skips safe(): the escape
  // reaches the terminal and hides "(not checked by attessa)".
  it('J1: a GitHub-shaped owner sourceRef with an ANSI escape in the repo name is printed escaped', async () => {
    w = await world('https://github.com/acme/risk\x1b[8m/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect(await w.call('--dry-run')).toBe(0);
    const owner = w.transcript.find((l) => l.startsWith("  Owner says it's built from "))!;
    expect(owner).toBeDefined();
    expect(owner).not.toMatch(ACTIVE);
  });

  it('J1: a GitHub-shaped owner sourceRef with a right-to-left override in the repo name is printed escaped', async () => {
    w = await world('github.com/acme/risk‮@a1b2c3d');
    expect(await w.call('--dry-run')).toBe(0);
    const owner = w.transcript.find((l) => l.startsWith("  Owner says it's built from "))!;
    expect(owner).toBeDefined();
    expect(owner).not.toMatch(ACTIVE);
  });

  // Same bypass in copy.ts sourceLabel, which `attessa status --agent <id>` (a buyer command, SPEC §8) uses to list
  // every release as "owner says {sourceLabel(sourceRef)}" (registry.ts agentStatus).
  it('sourceLabel: a GitHub-shaped sourceRef with an ANSI escape in the owner name is escaped', () => {
    expect(sourceLabel('https://github.com/ac\x1b[8mme/risk/commit/a1b2c3d4e5')).not.toMatch(ACTIVE);
  });

  // safe() documents that bidi controls are escaped. Unicode's Bidi_Control set is U+061C, U+200E, U+200F,
  // U+202A–U+202E, U+2066–U+2069; U+061C (ARABIC LETTER MARK) is missing, so it reaches the terminal raw.
  it('safe(): U+061C ARABIC LETTER MARK (a Unicode Bidi_Control) is escaped like the other bidi controls', () => {
    expect(safe('acme؜/risk')).not.toContain('؜');
  });

  // SPEC §7 key storage: "Never printed." FLOWS §6 J0: --keystore <file> is how an existing key is used. A file
  // holding a bare hex key (geth's `account import` format) passed as --keystore: JSON.parse throws, V8 quotes the
  // start of the file in its message, and the CLI prints that message ("Can't load the wallet: …").
  it('init --keystore <file with a bare hex key>: no part of the key is printed', async () => {
    let key = generatePrivateKey();
    while (!/^0x[a-d]/.test(key)) key = generatePrivateKey();
    const home = mkdtempSync(join(tmpdir(), 'attessa-adv2-ks-'));
    try {
      writeFileSync(join(home, 'key.txt'), `${key.slice(2)}\n`);
      const lines: string[] = [];
      const d: Deps = {
        io: { out: (l) => void lines.push(l), err: (l) => void lines.push(l), confirm: async () => false },
        env: { ATTESSA_KEYSTORE_PASSWORD: 'pw' },
        cwd: home,
        home,
        keychain: null,
        rpc: () => {
          throw new Error('unused');
        },
        runner: { run: async () => ({ code: 1, stdout: '', stderr: '' }) },
        fetch,
        enclave: () => {
          throw new Error('unused');
        },
        readFile: (p) => readFileSync(p),
        writeFile: (p, data) => writeFileSync(p, data),
        exists: (p) => existsSync(p),
        readdir: (p) => readdirSync(p),
        sleep: async () => {},
        arch: 'x64',
      };
      expect(await run(['init', '--keystore', 'key.txt'], d)).toBe(1);
      const all = lines.join('\n');
      expect(all).toContain("Can't load the wallet");
      expect(all).not.toContain(key.slice(2, 10));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
