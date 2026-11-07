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

// T21 adversary r18. `attessa status --pending --json` with two open calls in mixed states. report() runs once per
// call and each run merges that call's jsonResult into the one top-level --json object (Object.assign), on top of
// the `pending` array. Keys one call sets and the next call lacks stay behind, so the top-level object pairs the
// last call's requestId and outcome with the first call's settlementTx, code `uncertain` and suggestion
// `get_result`: a row for a call that was never settled, saying it was, with the next action of a settled one.
// FLOWS §7: "Refused, SettlePending and Uncertain resolve from chain state, never by guessing"; FLOWS §8 every row
// has exactly one next action ("interrupted after signing" -> `reconcile`, "interrupted, payment found" ->
// `get_result`); SPEC §8 `--json`. The world below is adversary-t21-r13.test.ts's, unchanged.

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

describe('status --pending --json over two open calls in mixed states', () => {
  it("the top-level object never pairs one call's requestId with another call's settlement and next action", async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    // Call A: settled on chain, /v1/results keeps answering 202 (FLOWS §8 "interrupted, payment found").
    w.gw.behavior = { paid: 'pending' };
    w.gw.behavior.pendingPolls = 100_000;
    expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--no-wait')).toBe(1);
    // Call B: a proxy's HTML 502, nothing settled (FLOWS §8 "interrupted after signing").
    w.gw.behavior = { paid: 'html502' };
    expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--no-wait', '--new')).toBe(1);
    const [a, b] = w.pending();
    expect(a!.state).toBe('uncertain');
    expect(b!.state).toBe('uncertain');

    // A's answer is still not served when status runs.
    w.gw.behavior = { paid: 'pending', pendingPolls: 100_000 };
    w.out.length = 0;
    expect(await w.cli('status', '--pending', ...LOCAL, '--json')).toBe(0);
    const after = w.pending();
    const txA = after[0]!.settlementTx as string;
    // Preconditions: A's settlement is on chain and recorded; B has none.
    expect(txA).toMatch(/^0x[0-9a-f]{64}$/);
    expect(after[1]!.settlementTx ?? null).toBeNull();

    const json = JSON.parse(w.out.at(-1)!) as Record<string, unknown> & { pending: Array<Record<string, unknown>> };
    // The per-call rows are right.
    expect(json.pending[0]).toMatchObject({ requestId: a!.requestId, code: 'uncertain', suggestion: 'get_result', settlementTx: txA });
    expect(json.pending[1]!.requestId).toBe(b!.requestId);
    expect(json.pending[1]!.settlementTx).toBeUndefined();
    // Any call-shaped row at the top level must be true of the call it names.
    const top = { requestId: json.requestId, outcome: json.outcome, settlementTx: json.settlementTx, suggestion: json.suggestion };
    if (top.requestId === b!.requestId) expect(top).toEqual({ requestId: b!.requestId, outcome: 'uncertain', settlementTx: undefined, suggestion: undefined });
    else expect(top.requestId === undefined || top.requestId === a!.requestId).toBe(true);
  }, 60_000);
});
