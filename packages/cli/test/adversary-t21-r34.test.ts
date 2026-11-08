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

// Adversary T21 r34: an origin with two live signers on two approved releases (FLOWS J4 "Its {n} live signers").
// The liveness check is answered by signer A (release R1, owner says commit a1b2c3d); the paid answer is proven by
// signer B (release R2, owner says commit 9f8e7d6). Both pass checkSigner, so the call is verified. The record must
// pair the release that produced the answer with that release's own owner claim, and the CLI must not say the
// answer came from "that approved build" (R1) when it came from R2.

const AGENT = 412n;
const SOURCE_R1 = 'https://github.com/acme/risk/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SOURCE_R2 = 'https://github.com/acme/risk/commit/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';

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
  const enclaveA = rnd();
  const enclaveB = rnd();
  const r1 = keccak256(stringToBytes(`release-r1-${Math.random()}`));
  const r2 = keccak256(stringToBytes(`release-r2-${Math.random()}`));
  chain.approveRelease(AGENT, r1, SOURCE_R1);
  chain.approveRelease(AGENT, r2, SOURCE_R2);
  // The gateway's liveness is signed by enclave A on release R1.
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId: r1, payTo, enclave: enclaveA });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclaveA.address, AGENT, r1, gw.originHash, operator);
  chain.registerSigner(enclaveB.address, AGENT, r2, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);
  // The paid request is executed by enclave B (release R2): an honest proof from the other live signer.
  gw.behavior = { proof: (p) => ({ ...p, releaseId: r2 }), signWith: enclaveB };
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv34-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    home,
    r1,
    r2,
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

describe('T21 adversary r34: the answer comes from another live signer on another approved release', () => {
  it("the evidence row pairs the answering release with that release's own owner claim (SPEC §7 evidence row)", async () => {
    w = await world();
    expect(await w.call()).toBe(0);
    const row = w.evidence().find((r) => r.outcome === 'verified');
    expect(row).toBeDefined();
    // The answer's proof names R2, and the record says so.
    expect(row!.releaseId).toBe(w.r2);
    // So the owner claim recorded beside it must be R2's, not that of R1, the release of the signer that answered liveness.
    expect(row!.ownerClaimedSource).toBe(SOURCE_R2);
  });

  it('the CLI never says the answer came from "that approved build" when the build it named above is another one', async () => {
    w = await world();
    expect(await w.call()).toBe(0);
    const t = w.transcript.join('\n');
    const shown = /\(release (0x[0-9a-f]{4})…([0-9a-f]{2}), Nitro enclave\)/.exec(t);
    expect(shown).not.toBeNull();
    // FLOWS J1: "Runs agent 412's approved build ... (release 0x9c4e…a1, Nitro enclave)", "Owner says it's built
    // from ...", then "Paid ... The answer came from that approved build". "That" build must be the one that answered.
    if (t.includes('The answer came from that approved build')) {
      expect(`${shown![1]}…${shown![2]}`).toBe(`${w.r2.slice(0, 6)}…${w.r2.slice(-2)}`);
    }
  });
});
