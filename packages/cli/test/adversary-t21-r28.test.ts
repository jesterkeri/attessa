import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

// T21 adversary r28. The r27 fix guards the evidence append inside finish() (client.ts:414) and the CLI acts on
// `evidenceNotWritten` only for `verified` (buyer.ts:453). Two other paths still go wrong when evidence.jsonl can't
// be appended (a real kernel ENOSPC: the file is a link to /dev/full, the rest of the folder writes):
// 1. paid_but_rejected: report() prints FLOWS's "Your record (~/.attessa/evidence.jsonl, entry {id}) proves the payment
//    and the failed check." though no row for {id} exists, and ends with no record_not_written row (SPEC §9 11a
//    "evidence + warning"; FLOWS §8 paid_but_rejected next action: "with record {requestId} from ~/.attessa/evidence.jsonl").
// 2. An honest gateway's refusal after signing (503 enclave_unavailable): paidRequest appends the refused row itself
//    (client.ts:761), outside finish()'s guard, so payAndVerify throws ENOSPC after signing and the CLI ends on
//    "Unexpected error (Error, ENOSPC)" instead of waiting for the chain and saying "Not charged" (SPEC §9 7a
//    "refused -> not_charged"; FLOWS §8: every error row has exactly one next action).
// The world below is adversary-t21-r27.test.ts's, unchanged.

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

async function service(chain: FakeChain, agent: bigint) {
  const rnd = () => privateKeyToAccount(generatePrivateKey());
  const operator = rnd().address.toLowerCase() as Address;
  const payTo = rnd().address.toLowerCase() as Address;
  const enclave = rnd();
  const releaseId = keccak256(stringToBytes(`release-${Math.random()}`));
  chain.approveRelease(agent, releaseId, SOURCE);
  const gw = new FakeGateway(chain, { agentId: agent, releaseId, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(agent, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, agent, releaseId, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  return { gw, origin, payTo };
}

async function buyerWorld() {
  const chain = new FakeChain({ startTime: 1_793_000_000n, startBlock: 31_204_000n });
  const s1 = await service(chain, 412n);
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-cli-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    s1,
    home,
    cwd: home,
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
        cwd: w.cwd,
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
      await s1.gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, 'tx1.json'), JSON.stringify({ chainId: String(chain.chainId), payTo: s1.payTo, asset: chain.asset, amount: '20000' }));
  return w;
}

let w: Awaited<ReturnType<typeof buyerWorld>>;
afterEach(async () => w?.close());

const LOCAL = ['--network', 'local', '--rpc', 'http://127.0.0.1:1'];

describe('T21 adversary r28: the evidence append fails on outcomes other than verified', () => {
  it('paid_but_rejected never says "Your record ... proves" when that record row was not written', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    const ev = join(w.home, '.attessa', 'evidence.jsonl');
    symlinkSync('/dev/full', ev);
    // The gateway settles and delivers a body that fails V10 (SPEC §9 11a), as buyer.test.ts's J2 variant.
    w.s1.gw.behavior = { tamperResponse: (b) => new TextEncoder().encode(new TextDecoder().decode(b).replace('allow', 'deny_')) };
    const code = await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx1.json', ...LOCAL);
    const [entry] = w.pending();
    const id = entry!.requestId as string;
    // Precondition: money moved and the call is decided paid_but_rejected.
    expect(entry!.state).toBe('paid_but_rejected');
    expect(entry!.settlementTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(code).toBe(1);
    // No row for this call is in the record: the append hit ENOSPC, and removing the link leaves no record at all.
    unlinkSync(ev);
    expect(existsSync(ev)).toBe(false);
    const claims = w.transcript.filter((l) => l.includes(`entry ${id}) proves`));
    expect(claims, `transcript:\n${w.transcript.join('\n')}`).toEqual([]);
  }, 60_000);

  it('an honest refusal after signing ends not_charged, never an unexpected error, when the record can not be written', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    symlinkSync('/dev/full', join(w.home, '.attessa', 'evidence.jsonl'));
    // Honest gateway: the enclave is down, it refuses with its §10 body and never settles.
    w.s1.gw.behavior = { paid: 'refuse', refuseWith: { status: 503, error: 'enclave_unavailable' } };
    const code = await w.cli('call', `${w.s1.origin}/v1/evaluate`, '--body', 'tx1.json', ...LOCAL);
    const [entry] = w.pending();
    expect(code).toBe(1);
    expect(w.transcript.filter((l) => l.startsWith('Unexpected error')), `transcript:\n${w.transcript.join('\n')}`).toEqual([]);
    expect(entry!.state).toBe('not_charged');
  }, 60_000);
});
