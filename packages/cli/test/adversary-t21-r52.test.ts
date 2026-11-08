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

// Adversary T21 r52: `attessa cancel` run with a wallet that isn't the one that paid the call.
//
// r51's fix makes the SDK's result fetch decide nothing for another wallet (packages/sdk/src/client.ts:612) and has
// `call` and `status --pending` say which wallet can fetch the answer (BUY.answerOtherWallet). `cancel` reports a
// settled call through the same report() but its context (packages/cli/src/commands/buyer.ts:630) carries no
// `wallet`, so after "Too late to cancel: the payment went through" it prints BUY.answerNotYet, "attessa status
// --pending checks again and fetches it". Run from that same shell, status --pending can't fetch it: only the payer's
// signature gets the answer (SPEC §6.1 "recovered == row payer").
//
// FLOWS.md:832 "Every error row has one next action": the one printed here cannot work from the wallet that read it.

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
  const r1 = keccak256(stringToBytes(`release-r52-${Math.random()}`));
  chain.approveRelease(AGENT, r1, SOURCE);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId: r1, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, r1, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv52-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    home,
    url: `${origin}/v1/evaluate`,
    /** Extra environment for the next runs (ATTESSA_PRIVATE_KEY, as an owner or operator shell has it). */
    env: {} as Record<string, string>,
    transcript: [] as string[],
    out: [] as string[],
    deps(): Deps {
      return {
        io: {
          out: (l) => void (w.out.push(l), w.transcript.push(l)),
          err: (l) => void w.transcript.push(l),
          confirm: async () => false,
        },
        env: { ATTESSA_REGISTRY: chain.registry, ...w.env },
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
    pendingRun: (...extra: string[]) => run(['status', '--pending', '--network', 'local', '--rpc', 'http://127.0.0.1:1', ...extra], w.deps()),
    pending(): Array<Record<string, unknown>> {
      const p = join(home, '.attessa', 'pending.jsonl');
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    reset() {
      w.transcript.length = 0;
      w.out.length = 0;
    },
    async close() {
      await gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, 'tx.json'), JSON.stringify({ chainId: String(chain.chainId), payTo, asset: chain.asset, amount: '20000' }));
  expect(await w.cli('init', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
  w.reset();
  return w;
}

let w: Awaited<ReturnType<typeof world>> | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/**
 * J1 interrupted, left for later: the gateway settled and stored the verified answer, then the connection dropped;
 * `--no-wait` leaves the call `uncertain` (the same ledger state a Ctrl-C after signing leaves).
 */
async function interruptedCall() {
  w = await world();
  w.gw.behavior = { paid: 'drop_after_settle' };
  expect(await w.call('--no-wait')).toBe(1);
  const e = w.pending()[0]!;
  expect(e.state).toBe('uncertain');
  w.reset();
  return { id: e.requestId as string, payer: e.payer as string };
}

const cancelRun = (id: string) => w!.cli('cancel', id, '--network', 'local', '--rpc', 'http://127.0.0.1:1');

describe('T21 adversary r52: attessa cancel from a wallet other than the call\'s payer', () => {
  it('control: the payer\'s own cancel on a settled call fetches the held answer and ends verified', async () => {
    const { id } = await interruptedCall();
    await cancelRun(id);
    expect(w!.pending()[0]).toMatchObject({ requestId: id, state: 'verified' });
  });

  it('"Too late to cancel" from another wallet sends the buyer to the paying wallet, not to a status --pending that cannot fetch', async () => {
    const { id, payer } = await interruptedCall();
    w!.env = { ATTESSA_PRIVATE_KEY: generatePrivateKey() };
    await cancelRun(id);
    const cancelOut = [...w!.out];
    w!.reset();

    // The printed next action, followed in the same shell, fetches nothing: the call stays open.
    await w!.pendingRun();
    expect(w!.pending()[0]).toMatchObject({ requestId: id, state: 'uncertain' });

    expect(cancelOut, `cancel printed: ${JSON.stringify(cancelOut)}`).toContain(
      `The answer isn't confirmed yet, and only the wallet that paid can fetch it. Run attessa status --pending with ${payer}.`,
    );
  });
});
