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

// Adversary T21 r38: a call whose process died after signing (V8 wrote the entry `signed`; the paid POST never reached
// the gateway). Re-running the same input resumes it (V0, FLOWS J1 interrupted "Resuming it instead of paying again").
// The gateway holds no result (its own 404 result_not_found), so the SDK waits through finalize for a block past
// validBefore + 5 (SPEC §7 "refused / uncertain -> final"), up to two minutes. Since r37 the CLI's `waiting` handler
// prints for a `refused` entry and for an `uncertain` one that had no "Lost the connection" line, but returns early for
// `signed` and `settle_pending`, so this wait prints nothing between "Resuming…" and "Not charged…".
// FLOWS.md:825 (§9 Status visible): "Every async state has a CLI line or HTTP status ... No silent waits".

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
  const r1 = keccak256(stringToBytes(`release-r1-${Math.random()}`));
  chain.approveRelease(AGENT, r1, SOURCE);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId: r1, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, r1, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv38-'));
  const keychain = new MemKeychain();
  // Run 1 stands for a process killed after V8: its paid POST never leaves (the fetch never settles), so the ledger
  // entry stays `signed` and the gateway never sees the payment permission.
  const hangingFetch: typeof fetch = (input, init) => {
    const h = new Headers(init?.headers);
    if (w.hangPaid && h.has('PAYMENT-SIGNATURE')) return new Promise<Response>(() => {});
    return fetch(input, init);
  };
  const w = {
    onSleep: undefined as (() => void) | undefined,
    hangPaid: false,
    sleeps: 0,
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
        sdk: { transport: chain.transport(), fetch: hangingFetch, sleep: async (ms: number) => {
            w.sleeps++;
            w.onSleep?.();
            chain.advance(Math.max(1, ms / 1000));
          }, receiptWaitMs: 2000, httpTimeoutMs: 5000 },
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

async function until(f: () => boolean, ms = 10_000) {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('T21 adversary r38: a resumed `signed` call with no result waits for expiry', () => {
  it('prints a line for the wait (FLOWS:825 "No silent waits"), as it does for refused and uncertain', async () => {
    w = await world();
    // Run 1: signs, then hangs in the paid POST (a process killed after V8). Never awaited.
    w.hangPaid = true;
    void w.call();
    await until(() => w!.pending()[0]?.state === 'signed');
    const id = w.pending()[0]!.requestId as string;
    const validBefore = BigInt(w.pending()[0]!.validBefore as string);
    expect(w.gw.paid.length).toBe(0); // the gateway never saw the permission
    w.hangPaid = false;

    // Run 2: same input, default wait. V0 resumes the signed entry.
    w.transcript.length = 0;
    const sleepsBefore = w.sleeps;
    const code = await w.call();
    const t = [...w.transcript];
    const joined = t.join('\n');
    expect(joined).toContain(`You already have a call in progress for this input (request ${id}). Resuming it instead of paying again.`);
    // It really waited: several polls, and the chain is past validBefore + 5 when it decided.
    expect(w.sleeps - sleepsBefore).toBeGreaterThan(3);
    expect(w.chain.head.timestamp).toBeGreaterThan(validBefore + 5n);
    expect(w.pending()[0]?.state).toBe('not_charged');
    expect(joined).toContain('Not charged: confirmed on Celo, your payment permission expired unused');
    expect(code).toBe(1);
    // The lines between "Resuming" and "Not charged": the wait must have one (FLOWS §8 "interrupted after signing"
    // or "refused, confirming"), not nothing.
    const from = t.findIndex((l) => l.includes('Resuming it instead of paying again'));
    const to = t.findIndex((l) => l.startsWith('Not charged:'));
    expect(to).toBeGreaterThan(from);
    expect(t.slice(from + 1, to), `transcript:\n${joined}`).not.toEqual([]);
  });
});
