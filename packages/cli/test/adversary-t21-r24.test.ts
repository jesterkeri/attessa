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

// T21 adversary r24.
// (1) The r23 data-folder guard runs only when --out is given (buyer.ts `o.out !== undefined && intoDataDir(...)`).
// Without --out the answer goes to `result.json` in the working folder unchecked, so a `result.json` that is a link to
// `~/.attessa/evidence.jsonl` takes the paid answer over the evidence log: every row in it is gone. SPEC §9: every
// outcome is in evidence; the guard's own rule (buyer.ts): an answer written over the ledger, evidence or config
// "would destroy it".
// (2) The SDK records the call `verified` (terminal, V12) before the CLI writes the answer. A process that dies in
// between (SIGKILL, power loss, Ctrl-C) leaves no answer file anywhere, and getResult never re-fetches a terminal
// entry, yet the next `attessa cancel <id>` says "It was saved when it arrived". The death is simulated by an io.data
// hook that throws at the top of report(), the last step before the answer write. Same false line when both the
// --out and the kept-file write fail ("it wasn't saved"), shown with a writeFile that refuses answers (a full disk).
// The world below is adversary-t21-r23.test.ts's.

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
    /** Set to make the next report() die before it writes the answer. */
    killAtReport: false,
    /** Set to make every answer write fail, as on a full disk (config.json still writes). */
    refuseAnswers: false,
    deps(): Deps {
      return {
        io: {
          out: (l) => void w.out.push(l),
          err: (l) => void w.err.push(l),
          confirm: async () => true,
          data: () => {
            if (w.killAtReport) throw new Error('killed');
          },
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
        writeFile: (p, d) => {
          if (w.refuseAnswers && !p.endsWith('config.json')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
          writeFileSync(p, d);
        },
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
    /** Answer files anywhere the CLI writes them: the working folder and the data folder. */
    answers(): string[] {
      const skip = new Set(['tx.json', 'config.json']);
      return [home, join(home, '.attessa')].flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.json') && !skip.has(f)));
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

describe('the default result.json is held to the same data-folder rule as --out', () => {
  it('a result.json that links to evidence.jsonl never takes the answer over the evidence log', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--out', 'first.json')).toBe(0);
    const evidence = join(w.home, '.attessa', 'evidence.jsonl');
    const before = readFileSync(evidence, 'utf8');
    expect(before).toContain('"outcome":"verified"');
    symlinkSync(evidence, join(w.home, 'result.json'));
    await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--new');
    const after = readFileSync(evidence, 'utf8');
    expect(after.startsWith(before), `evidence.jsonl was overwritten; it now starts: ${after.slice(0, 60)}`).toBe(true);
  }, 60_000);
});

describe('a verified call whose answer was never written', () => {
  it('killed between the ledger write and the answer write: a later cancel never says it was saved', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    w.killAtReport = true;
    await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL);
    w.killAtReport = false;
    // Preconditions: paid, recorded verified (terminal), and no answer in any file.
    expect(w.gw.paid).toHaveLength(1);
    expect(w.pending()[0]!.state).toBe('verified');
    expect(w.answers()).toEqual([]);
    const id = w.pending()[0]!.requestId as string;
    w.out.length = 0;
    w.err.length = 0;
    await w.cli('cancel', id, ...LOCAL, '--yes');
    expect(w.out.join('\n')).not.toContain('It was saved when it arrived');
  }, 60_000);

  it('after "it wasn\'t saved" (neither --out nor the data folder took it): a later cancel never says it was saved', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    w.refuseAnswers = true;
    expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL)).toBe(1);
    expect(w.err[0]).toContain("but it wasn't saved");
    w.refuseAnswers = false;
    expect(w.pending()[0]!.state).toBe('verified');
    expect(w.answers()).toEqual([]);
    const id = w.pending()[0]!.requestId as string;
    w.out.length = 0;
    w.err.length = 0;
    await w.cli('cancel', id, ...LOCAL, '--yes');
    expect(w.out.join('\n')).not.toContain('It was saved when it arrived');
  }, 60_000);
});
