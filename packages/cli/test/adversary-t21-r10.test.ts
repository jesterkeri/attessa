import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
// Absolute paths because this file was written outside the working copy; inside packages/cli/test they are
// '../../sdk/test/fakes/chain.ts', '../../sdk/test/fakes/gateway.ts', '../src/context.ts' and '../src/index.ts'.
import { FakeChain, RpcFailure } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// T21 adversary r10. `attessa cancel` maps SDK errors with chainReads: false, so any SdkRpcError (or viem error)
// thrown by cancelAuthorization falls to run()'s catch-all: "Unexpected error (RpcError). Its message isn't
// printed..." with no next action. FLOWS §9 "Recovery": "Every error row has one next action".
// (1) The RPC drops at the SDK's first read of the authorization's logs, before the cancel permission or its
//     transaction is signed: the FLOWS §8 rpc_unavailable row ("Can't reach Celo at {rpc}. Nothing was signed.")
//     is true there, and is what `attessa call`, `status --pending` and the seller writes print for the same drop.
// (2) The RPC drops after the cancel transaction was broadcast, while its receipt is polled: the user gets no
//     tx hash and no next action, though the cancel may have landed.

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
const RPC_ROW = [`Can't reach Celo at ${RPC}. Nothing was signed.`, 'Retry or set another `--rpc`.'];

async function openCall() {
  w = await buyerWorld();
  expect(await w.cli('init')).toBe(0);
  w.gw.behavior = { paid: 'pending_no_settle' };
  expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--no-wait')).toBe(1);
  const e = w.pending()[0]! as { requestId: Hex; payer: Address; nonce: Hex; amount: string };
  expect(w.chain.authUsed(e.payer, e.nonce)).toBe(false);
  return e;
}

describe('attessa cancel when the RPC drops mid-command (FLOWS §8 rpc unavailable, §9 Recovery)', () => {
  it('drop at the first eth_getLogs, before anything is signed: the rpc_unavailable row, not "Unexpected error"', async () => {
    const e = await openCall();
    w.chain.logsDown = true; // eth_chainId and the head still answer, so the SDK's net() check passes
    w.chain.calls.length = 0;
    w.transcript.length = 0;
    w.err.length = 0;
    expect(await w.cli('cancel', e.requestId, ...LOCAL, '--yes')).toBe(1);
    expect(w.chain.calls).not.toContain('eth_sendRawTransaction');
    expect(w.err).toEqual(RPC_ROW);
  });

  it('drop after the cancel was broadcast, while its receipt is polled: a row with one next action, not "Unexpected error"', async () => {
    const e = await openCall();
    const orig = w.chain.request.bind(w.chain);
    let sent = false;
    w.chain.request = async (m: string, p: unknown[] = []) => {
      if (sent && (m === 'eth_getTransactionReceipt' || m === 'eth_getTransactionByHash')) throw new RpcFailure(`${m}: connect ECONNREFUSED`);
      const r = await orig(m, p);
      if (m === 'eth_sendRawTransaction') sent = true;
      return r;
    };
    w.transcript.length = 0;
    w.err.length = 0;
    expect(await w.cli('cancel', e.requestId, ...LOCAL, '--yes')).toBe(1);
    expect(sent).toBe(true);
    expect(w.err.join('\n')).not.toMatch(/Unexpected error/);
    expect(w.err.join('\n')).not.toMatch(/Nothing was (sent|signed)/);
    expect(w.err.length).toBe(2); // the row, then its one next action
  }, 60_000);
});
