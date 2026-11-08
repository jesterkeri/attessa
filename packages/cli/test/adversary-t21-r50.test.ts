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

// Adversary T21 r50: `attessa cancel <id>` without --yes, the command J2 prints as its one next action ("To void it
// right now instead: attessa cancel {id}"), and the only one `stillOpen` offers ("attessa cancel {id} voids it now").
//
// cancel() (packages/cli/src/commands/buyer.ts:634) calls `io.confirm('cancel')` with no line before it, so the
// prompt names no consequence (an on-chain transaction from the buyer's wallet, gas paid in CELO, the permission
// voided for good). A declined prompt returns 1 with no line and no next action. bin.ts's confirm returns false
// whenever stdin is not a TTY, so an agent that runs the printed command exactly as printed always gets exit 1 and
// an empty transcript, and the open permission stays open.
//
// FLOWS.md:833 "Confirms only where there is no undo and money or service is at stake: `agent register`, `release
// approve`, `signer register`, `revoke`, and `call --via buy`. Each prompt names the consequence and uses the verb as
// the button. ... Cancel no longer prompts". FLOWS.md:832 "Every error row has one next action". FLOWS.md:825 "No
// silent waits" / status visible.

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
  const r1 = keccak256(stringToBytes(`release-r50-${Math.random()}`));
  chain.approveRelease(AGENT, r1, SOURCE);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId: r1, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, r1, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv50-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    home,
    url: `${origin}/v1/evaluate`,
    transcript: [] as string[],
    out: [] as string[],
    err: [] as string[],
    /** bin.ts: `if (!process.stdin.isTTY) return false;` An agent, a pipe, CI. */
    tty: false,
    /** How many lines were printed when the prompt was shown, or null if it never was. */
    promptAt: null as number | null,
    deps(): Deps {
      return {
        io: {
          out: (l) => void (w.out.push(l), w.transcript.push(l)),
          err: (l) => void (w.err.push(l), w.transcript.push(l)),
          confirm: async () => {
            w.promptAt = w.transcript.length;
            return w.tty;
          },
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
    reset() {
      w.transcript.length = 0;
      w.out.length = 0;
      w.err.length = 0;
      w.promptAt = null;
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

/** A refused call left open by --no-wait; its last line offers `attessa cancel <id>`. */
async function openCall() {
  w = await world();
  w.gw.behavior = { paid: 'refuse' };
  expect(await w.call('--no-wait')).toBe(1);
  const id = w.pending()[0]!.requestId as string;
  expect(w.transcript.at(-1)).toContain(`attessa cancel ${id} voids it now.`);
  w.reset();
  return id;
}

const CANCEL = (id: string, ...extra: string[]) => ['cancel', id, '--network', 'local', '--rpc', 'http://127.0.0.1:1', ...extra];

describe('T21 adversary r50: attessa cancel <id> run as printed, without --yes', () => {
  it('non-interactive (stdin not a TTY): never exit 1 with no line and no next action', async () => {
    const id = await openCall();
    const code = await w!.cli(...CANCEL(id));
    // Either the cancel runs (FLOWS:833 "Cancel no longer prompts") or the run says what didn't happen and what to do.
    if (code === 0) {
      expect(w!.transcript[0]).toMatch(/^Cancelled \(tx 0x/);
      expect(w!.pending()[0]).toMatchObject({ state: 'not_charged', code: 'cancelled' });
    } else {
      expect(w!.err.length, `exit ${code}; transcript: ${JSON.stringify(w!.transcript)}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('--json, non-interactive: the result names an error and its next action, or the cancel', async () => {
    const id = await openCall();
    const code = await w!.cli(...CANCEL(id, '--json'));
    const j = JSON.parse(w!.out.at(-1)!);
    if (code === 0) expect(j).toMatchObject({ ok: true, outcome: 'not_charged', code: 'cancelled' });
    else expect(j, JSON.stringify(j)).toMatchObject({ ok: false, error: expect.any(String), next: expect.any(String) });
  });

  it('interactive: a prompt, if shown, comes after a line naming its consequence (an on-chain cancel paid in CELO)', async () => {
    const id = await openCall();
    w!.tty = true;
    await w!.cli(...CANCEL(id));
    if (w!.promptAt !== null) {
      const before = w!.transcript.slice(0, w!.promptAt);
      expect(before.some((l) => /CELO/.test(l) && /cancel/i.test(l)), `printed before the prompt: ${JSON.stringify(before)}`).toBe(true);
    }
  });
});
