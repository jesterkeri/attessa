import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

// T21 adversary r23. `attessa call --out <file>` refuses a file inside the data folder, "symlinks resolved" (r22), but
// only the folder part of --out is resolved: the file name is taken as typed. So an --out that is itself a symlink to
// `~/.attessa/evidence.jsonl` passes the check, the call is paid, and writeFile follows the link: the answer is
// written over the evidence log, and every row in it (this call's included) is gone. SPEC §9: every outcome is in
// evidence. The guard's own rule (buyer.ts): an answer written over the ledger, evidence or config "would destroy it".
// The world below is buyer.test.ts's.

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
    url: `${origin}/v1/evaluate`,
    home,
    out: [] as string[],
    err: [] as string[],
    env: { ATTESSA_REGISTRY: chain.registry } as Record<string, string | undefined>,
    deps(): Deps {
      return {
        io: { out: (l) => void w.out.push(l), err: (l) => void w.err.push(l), confirm: async () => true },
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

const LOCAL = ['--network', 'local', '--rpc', 'http://127.0.0.1:1'];

describe('call --out that is itself a symlink into the data folder', () => {
  it('is refused before signing, and the evidence log is left whole', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    // An earlier call, so the evidence log holds a row worth keeping.
    expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--out', 'first.json')).toBe(0);
    const evidence = join(w.home, '.attessa', 'evidence.jsonl');
    const before = readFileSync(evidence, 'utf8');
    expect(before).toContain('"outcome":"verified"');
    // `answer.json` in the working folder (outside ~/.attessa) is a link to the evidence log.
    symlinkSync(evidence, join(w.home, 'answer.json'));
    w.out.length = 0;
    w.err.length = 0;
    const paidBefore = w.gw.paid.length;
    const code = await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--new', '--out', 'answer.json');
    const after = readFileSync(evidence, 'utf8');
    // Whichever way a fix goes (refuse the link, or never write through it), the evidence log keeps every row it had.
    expect(after.startsWith(before), `evidence.jsonl was overwritten; it now starts: ${after.slice(0, 60)}`).toBe(true);
    expect(code).toBe(1);
    expect(w.err[0]).toBe("--out can't be inside ~/.attessa, which holds your records. Choose another file.");
    expect(w.gw.paid.length).toBe(paidBefore);
  }, 60_000);
});
