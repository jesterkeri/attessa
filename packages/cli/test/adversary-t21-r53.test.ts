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

// Adversary T21 r53: an open, unsettled call reported to a wallet that isn't the call's payer.
//
// r51/r52 made the SDK's result fetch decide nothing for another wallet and made `call`, `status --pending` and
// `cancel` send that wallet to the paying one for the answer (BUY.answerOtherWallet). A call with no settlement on
// chain still ends on BUY.stillOpen (packages/cli/src/commands/buyer.ts:501), "attessa cancel {id} voids it now",
// and a waiting resume prints BUY.voidHint, "To void it right now instead: attessa cancel {id}". From that same
// shell the cancel can't void it: EIP-3009 cancelAuthorization takes the authorizer's own signature, and
// cancelAuthorization (packages/sdk/src/client.ts:1214) signs with the loaded wallet for `authorizer: entry.payer`.
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
  const r1 = keccak256(stringToBytes(`release-r53-${Math.random()}`));
  chain.approveRelease(AGENT, r1, SOURCE);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId: r1, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, r1, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv53-'));
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

/** J1 interrupted, left for later, with nothing settled: a proxy's 502 after signing, then `--no-wait`. */
async function openCall() {
  w = await world();
  w.gw.behavior = { paid: 'html502' };
  expect(await w.call('--no-wait')).toBe(1);
  const e = w.pending()[0]!;
  expect(e.state).toBe('uncertain');
  expect(e.settlementTx ?? null).toBeNull();
  w.reset();
  return { id: e.requestId as string, payer: e.payer as string };
}

const cancelRun = (id: string) => w!.cli('cancel', id, '--network', 'local', '--rpc', 'http://127.0.0.1:1');
const offersCancel = (lines: string[], id: string) => lines.some((l) => l.includes(`attessa cancel ${id}`));

describe('T21 adversary r53: the cancel offered to a wallet that is not the payer of an open call', () => {
  it("control: the payer's own status --pending offers cancel, and that cancel voids the permission", async () => {
    const { id } = await openCall();
    expect(await w!.pendingRun()).toBe(0);
    expect(offersCancel(w!.transcript, id)).toBe(true);
    w!.reset();
    expect(await cancelRun(id)).toBe(0);
    expect(w!.pending()[0]).toMatchObject({ requestId: id, state: 'not_charged' });
  });

  it('status --pending from another wallet: the cancel it offers must work from that wallet', async () => {
    const { id } = await openCall();
    w!.env = { ATTESSA_PRIVATE_KEY: generatePrivateKey() };
    expect(await w!.pendingRun()).toBe(0);
    const statusOut = [...w!.transcript];
    w!.reset();

    // The printed next action, followed in the same shell.
    const code = await cancelRun(id);
    const cancelOut = [...w!.transcript];
    const voided = code === 0 && w!.pending()[0]?.state === 'not_charged';

    expect(
      offersCancel(statusOut, id) && !voided,
      `status --pending printed: ${JSON.stringify(statusOut)}\ncancel (exit ${code}) printed: ${JSON.stringify(cancelOut)}`,
    ).toBe(false);
  });

  it('attessa call from another wallet, resuming that open call and waiting: the void hint must work from that wallet', async () => {
    const { id } = await openCall();
    w!.env = { ATTESSA_PRIVATE_KEY: generatePrivateKey() };
    // Same input, no --new: V0 resumes the open entry. Stop the wait at the first void hint (as Ctrl-C would).
    const lines: string[] = [];
    const d = w!.deps();
    const io = { ...d.io, out: (l: string) => { lines.push(l); d.io.out(l); } };
    let hinted = false;
    const sdk = { ...d.sdk!, sleep: async (ms: number) => { if (offersCancel(lines, id)) { hinted = true; throw new Error('stopped by the test at the hint'); } await d.sdk!.sleep!(ms); } };
    await run(['call', w!.url, '--body', 'tx.json', '--network', 'local', '--rpc', 'http://127.0.0.1:1'], { ...d, io, sdk }).catch(() => 1);
    const callOut = [...lines];
    w!.reset();

    const code = await cancelRun(id);
    const cancelOut = [...w!.transcript];
    const voided = code === 0 && w!.pending()[0]?.state === 'not_charged';

    expect(
      (hinted || offersCancel(callOut, id)) && !voided,
      `call printed: ${JSON.stringify(callOut)}\ncancel (exit ${code}) printed: ${JSON.stringify(cancelOut)}`,
    ).toBe(false);
  });
});
