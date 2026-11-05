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

// Adversary T21 r51: `attessa status --pending` run with a wallet that isn't the one that signed the call.
//
// The pending ledger is one file per data folder (SPEC §7 `<dataDir>/pending.jsonl`) and each entry records its
// `payer`, but reconcilePending (packages/sdk/src/client.ts:1265) drives every open entry with whatever wallet this
// run loaded, and fetchResult (client.ts:616) signs `X-Attest-Payer-Sig` with `cfg.account`, not the entry's payer.
// The gateway answers a signature from anyone but the row's payer with the same 404 `result_not_found` as a missing
// result (packages/gateway/src/gateway.ts:229; SPEC §6.1 "recovered == row payer"), and the SDK counts that 404 as
// decisive (client.ts:636). So a settled call whose verified answer the gateway holds is decided terminal
// `paid_but_rejected{missing_proof}` ("the gateway's fault"), and the answer is never fetched again (getResult never
// re-fetches a terminal entry, SPEC §7 V12).
//
// The buyer commands take ATTESSA_PRIVATE_KEY before the OS keychain (SPEC §7 key storage; FLOWS J0), and the owner
// and operator commands read the same variable, so a buyer who calls with the keychain wallet and later runs the
// command J1/J2 print ("attessa status --pending checks later") in a shell with ATTESSA_PRIVATE_KEY set hits this.
//
// SPEC §7: "Uncertain --> PaidButRejected: settled but no valid result retrievable" (FLOWS §7) and "`Refused`,
// `SettlePending` and `Uncertain` resolve from chain state, never by guessing" (FLOWS.md:640). The result is
// retrievable: the payer's own signature gets it.

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
  const r1 = keccak256(stringToBytes(`release-r51-${Math.random()}`));
  chain.approveRelease(AGENT, r1, SOURCE);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId: r1, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, r1, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv51-'));
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

describe('T21 adversary r51: status --pending with a wallet other than the call\'s payer', () => {
  it('control: the payer\'s own wallet fetches the held answer and ends verified', async () => {
    const { id } = await interruptedCall();
    expect(await w!.pendingRun()).toBe(0);
    expect(w!.pending()[0]).toMatchObject({ requestId: id, state: 'verified' });
    expect(existsSync(join(w!.home, `${id}.json`))).toBe(true);
  });

  it('another wallet (ATTESSA_PRIVATE_KEY set) must not decide a settled call whose answer the gateway holds', async () => {
    const { id, payer } = await interruptedCall();
    const other = generatePrivateKey();
    expect(privateKeyToAccount(other).address.toLowerCase()).not.toBe(payer);
    w!.env = { ATTESSA_PRIVATE_KEY: other };
    await w!.pendingRun();
    const afterOther = w!.pending()[0]!;
    const otherTranscript = [...w!.transcript];
    w!.reset();

    // Back in the payer's shell: the answer the gateway still holds must still be fetchable and verify.
    w!.env = {};
    await w!.pendingRun();
    const final = w!.pending()[0]!;
    expect(
      { afterOtherWallet: afterOther.state, code: afterOther.code, finalState: final.state },
      `other-wallet run printed: ${JSON.stringify(otherTranscript)}; payer run printed: ${JSON.stringify(w!.transcript)}`,
    ).toMatchObject({ finalState: 'verified' });
    expect(existsSync(join(w!.home, `${id}.json`))).toBe(true);
  });
});
