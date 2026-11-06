import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain, RpcFailure } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// T21 adversary r11. After an interrupted cancel (the cancel tx landed, but the RPC dropped while its receipt was
// polled), the natural retry is `attessa cancel <id>` again. The SDK's first read finds the AuthorizationCanceled
// log and returns that tx without recording the outcome, so the CLI prints "Cancelled (tx ...)" and --json says
// outcome not_charged, while the pending ledger keeps the call open: the reservation is not released and
// `status --pending` still lists it. SPEC §7: "Cancel (`cancelAuthorization`) makes `not_charged` immediate on
// confirmation"; FLOWS §7: "The reservation is released on NotCharged/Cancelled". buyer.test.ts's own cancel test
// holds the same contract: after "Cancelled (tx ...)" the entry is { state: 'not_charged', code: 'cancelled' }.
// The world below is adversary-t21-r10.test.ts's, unchanged.

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

async function openCall() {
  w = await buyerWorld();
  expect(await w.cli('init')).toBe(0);
  w.gw.behavior = { paid: 'pending_no_settle' };
  expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--no-wait')).toBe(1);
  const e = w.pending()[0]! as { requestId: Hex; payer: Address; nonce: Hex; amount: string };
  expect(w.chain.authUsed(e.payer, e.nonce)).toBe(false);
  return e;
}

describe('attessa cancel re-run after an interrupted cancel that landed (SPEC §7 cancel makes not_charged)', () => {
  it('the second cancel says "Cancelled" and --json not_charged: the ledger records not_charged too', async () => {
    const e = await openCall();
    const orig = w.chain.request.bind(w.chain);
    let sent = false;
    let down = true;
    w.chain.request = async (m: string, p: unknown[] = []) => {
      if (down && sent && (m === 'eth_getTransactionReceipt' || m === 'eth_getTransactionByHash')) throw new RpcFailure(`${m}: connect ECONNREFUSED`);
      const r = await orig(m, p);
      if (m === 'eth_sendRawTransaction') sent = true;
      return r;
    };
    w.err.length = 0;
    expect(await w.cli('cancel', e.requestId, ...LOCAL, '--yes')).toBe(1);
    expect(w.err[0]).toMatch(/^Lost the connection to Celo after sending the cancel \(tx 0x[0-9a-f]{64}\); it may still land\.$/);
    // The cancel did land on the chain.
    expect(w.chain.authUsed(e.payer, e.nonce)).toBe(true);

    // The RPC is back; the user runs the same cancel again.
    down = false;
    w.out.length = 0;
    expect(await w.cli('cancel', e.requestId, ...LOCAL, '--yes', '--json')).toBe(0);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: true, outcome: 'not_charged', code: 'cancelled' });
    expect(w.pending().find((p) => p.requestId === e.requestId)).toMatchObject({ state: 'not_charged', code: 'cancelled' });
  }, 60_000);
});
