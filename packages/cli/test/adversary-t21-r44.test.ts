import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, toEventSelector, toFunctionSelector, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// Adversary T21 r44: r43 made finalize read authorizationState on every pass, so a permission the token already reads
// used gets the used-waiting line, never the confirming line. But finalize announces `waiting` on the first pass that
// read the head, whether or not that pass's authorizationState read succeeded. When that one read fails (an RpcError,
// which a waiting call retries), the announcement goes out without `used`, and the CLI prints "your payment permission
// expires unused at {t} UTC" and "To void it right now instead: attessa cancel {id}" while the token already reads the
// permission used (the facilitator settled before the refusal). The next pass reads it used and the run ends on
// cancel's undecided row; the cancel it offered can't void it. SPEC.md:635 (state true: used, never "expires
// unused"); FLOWS.md:832 (one next action, which must be one that works).

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
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv44-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    home,
    url: `${origin}/v1/evaluate`,
    transcript: [] as string[],
    /** Each printed line with whether the token read the permission used at that moment. */
    said: [] as Array<{ line: string; used: boolean }>,
    usedNow(): boolean {
      const [e] = w.pending();
      return e?.nonce ? chain.authUsed(e.payer as Address, e.nonce as `0x${string}`) : false;
    },
    deps(): Deps {
      return {
        io: {
          out: (l) => {
            w.said.push({ line: l, used: w.usedNow() });
            w.transcript.push(l);
          },
          err: (l) => void w.transcript.push(l),
          confirm: async () => true,
        },
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
        sdk: {
          transport: chain.transport(),
          sleep: async (ms: number) => {
            chain.advance(Math.max(1, ms / 1000));
          },
          receiptWaitMs: 2000,
          httpTimeoutMs: 5000,
        },
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
  w.said.length = 0;
  return w;
}

let w: Awaited<ReturnType<typeof world>> | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/** The RPC's log index lags: eth_getLogs leaves out AuthorizationUsed, while authorizationState already reads true. */
function hideUsedLogs(chain: FakeChain): void {
  const used = toEventSelector('AuthorizationUsed(address,bytes32)');
  const orig = chain.request.bind(chain);
  chain.request = async (method: string, params: unknown[] = []) => {
    const r = await orig(method, params);
    if (method === 'eth_getLogs') return (r as Array<{ topics: string[] }>).filter((l) => l.topics[0] !== used);
    return r;
  };
}

/** One flaky read: the first authorizationState eth_call fails, as a load-balanced RPC does now and then. */
function failFirstStateRead(chain: FakeChain): { failed: boolean } {
  const sel = toFunctionSelector('authorizationState(address,bytes32)');
  const orig = chain.request.bind(chain);
  const s = { failed: false };
  chain.request = async (method: string, params: unknown[] = []) => {
    const tx = (params[0] ?? {}) as { data?: string; input?: string };
    const input = tx.data ?? tx.input ?? '';
    if (method === 'eth_call' && !s.failed && input.startsWith(sel)) {
      s.failed = true;
      const e = new Error('authorizationState unavailable') as Error & { code: number };
      e.code = -32000;
      throw e;
    }
    return orig(method, params);
  };
  return s;
}

describe('T21 adversary r44: a refused call the chain already reads used, no log yet, the first state read fails', () => {
  it('does not offer a cancel that cannot void it, nor say the permission expires unused', async () => {
    w = await world();
    // The gateway refuses with a section 10 body but its facilitator settled first (FLOWS settled_after_refusal).
    w.gw.behavior = { paid: 'refuse_but_settle' };
    hideUsedLogs(w.chain);
    const flaky = failFirstStateRead(w.chain);
    const code = await w.call();
    const [entry] = w.pending();
    const id = entry!.requestId as `0x${string}`;
    expect(flaky.failed).toBe(true);
    expect(code).toBe(1);
    // The run ends on cancel's undecided row (r40): the SDK itself read the permission used on this run.
    expect(w.transcript.join('\n')).toContain("Your payment permission was already used or cancelled, but Celo doesn't show which yet.");

    // No line may promise an unused expiry or offer the cancel while the token already reads the permission used.
    const offers = w.said.filter((s) => s.line.includes(`attessa cancel ${id}`) || s.line.includes('expires unused at'));
    expect(offers.filter((s) => s.used).map((s) => s.line)).toEqual([]);
  });
});
