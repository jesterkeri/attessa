import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway, type Behavior } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// T21a `attessa verify`: the real CLI and SDK against the SDK's in-process fake chain and gateway. No network, every key
// generated in the test. A call is made first (that needs a wallet); verify itself must need none.

const AGENT = 412n;
const NET = ['--network', 'sepolia'];
const NET_LOCAL = ['--network', 'local', '--rpc', 'http://127.0.0.1:1'];

class WatchedKeychain implements Keychain {
  touched = 0;
  store = new Map<string, string>();
  async getPassword(s: string, a: string): Promise<string | null> {
    this.touched++;
    return this.store.get(`${s}/${a}`) ?? null;
  }
  async setPassword(s: string, a: string, p: string): Promise<void> {
    this.touched++;
    this.store.set(`${s}/${a}`, p);
  }
}

async function world(behavior: Behavior = {}) {
  const chain = new FakeChain({ startTime: 1_793_000_000n, startBlock: 31_204_000n });
  const rnd = () => privateKeyToAccount(generatePrivateKey());
  const operator = rnd().address.toLowerCase() as Address;
  const payTo = rnd().address.toLowerCase() as Address;
  const enclave = rnd();
  const releaseId = keccak256(stringToBytes(`release-${Math.random()}`));
  chain.approveRelease(AGENT, releaseId);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId, payTo, enclave });
  gw.behavior = behavior;
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, releaseId, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);

  const home = mkdtempSync(join(tmpdir(), 'attessa-verify-'));
  const keychain = new WatchedKeychain();
  const w = {
    chain,
    gw,
    origin,
    home,
    keychain,
    enclave,
    operator,
    releaseId,
    out: [] as string[],
    err: [] as string[],
    env: { ATTESSA_REGISTRY: chain.registry } as Record<string, string | undefined>,
    deps(env = w.env): Deps {
      return {
        io: { out: (l) => void w.out.push(l), err: (l) => void w.err.push(l), confirm: async () => true },
        env,
        cwd: home,
        home,
        keychain,
        rpc: () => {
          throw new Error('verify uses the SDK transport');
        },
        runner: { run: async () => ({ code: 1, stdout: '', stderr: 'no runner' }) },
        fetch,
        enclave: () => {
          throw new Error('no enclave');
        },
        readFile: (p) => readFileSync(p),
        writeFile: (p, d) => writeFileSync(p, d),
        exists: (p) => existsSync(p),
        readdir: (p) => readdirSync(p),
        sleep: async () => {},
        arch: 'x64',
        sdk: { transport: chain.transport(), sleep: async (ms: number) => chain.advance(Math.max(1, ms / 1000)), receiptWaitMs: 2000, httpTimeoutMs: 5000 },
      };
    },
    cli(...argv: string[]) {
      return run(argv, w.deps());
    },
    /** `attessa call` on the fake chain; returns the requestId. */
    async call(...extra: string[]): Promise<Hex> {
      const code = await run(['call', `${origin}/v1/evaluate`, '--body', 'tx.json', ...NET_LOCAL, ...extra], w.deps());
      if (!existsSync(join(home, '.attessa', 'pending.jsonl'))) throw new Error(`call wrote no ledger entry (exit ${code}): ${[...w.out, ...w.err].join(' | ')}`);
      w.out.length = 0;
      w.err.length = 0;
      const line = readFileSync(join(home, '.attessa', 'pending.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { requestId: Hex });
      return line.at(-1)!.requestId;
    },
    /** The proof header and answer the gateway kept for this call, written as files the buyer would have saved. */
    keep(id: Hex): { proof: string; response: string } {
      const r = w.gw.results.get(id)!;
      writeFileSync(join(home, 'kept.proof'), r.proofHeader!);
      writeFileSync(join(home, 'kept.response'), r.body);
      return { proof: 'kept.proof', response: 'kept.response' };
    },
    verify(id: string, ...extra: string[]) {
      w.out.length = 0;
      return run(['verify', id, ...NET, ...extra], w.deps());
    },
    row(check: string): string {
      return w.out.find((l) => l.includes(` ${check}:`)) ?? '';
    },
    async close() {
      await gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, 'tx.json'), JSON.stringify({ chainId: String(chain.chainId), payTo, asset: chain.asset, amount: '20000' }));
  return w;
}
type W = Awaited<ReturnType<typeof world>>;
let w: W;
afterEach(async () => w?.close());

async function started(behavior: Behavior = {}): Promise<W> {
  w = await world(behavior);
  expect(await w.cli('init')).toBe(0);
  return w;
}

const PASS = /^pass /;
const FAIL = /^FAIL /;
const SKIP = /^not checked /;
const SCAN = 'https://sepolia.celoscan.io/';

describe('verify: a call that went through', () => {
  it('verify passes every check for a requestId, with a Celoscan link on every line, and exits 0', async () => {
    await started();
    const id = await w.call();
    const kept = w.keep(id);
    expect(await w.verify(id, '--proof', kept.proof, '--response', kept.response)).toBe(0);
    for (const c of ['release', 'signer', 'signature', 'binding', 'settlement']) {
      expect(w.row(c), c).toMatch(PASS);
      expect(w.row(c), c).toContain(SCAN);
    }
    expect(w.row('settlement')).toContain(`${SCAN}tx/${w.gw.results.get(id)!.tx}`);
    expect(w.out.at(-1)).toBe('Verified: every check passed.');
  });

  it('verify accepts the settlement tx for a call it has a record of, and --json is one object with every check', async () => {
    await started();
    const id = await w.call();
    const kept = w.keep(id);
    const tx = w.gw.results.get(id)!.tx!;
    expect(await w.verify(tx, '--proof', kept.proof, '--response', kept.response, '--json')).toBe(0);
    expect(w.out).toHaveLength(1);
    const j = JSON.parse(w.out[0]!);
    expect(j.ok).toBe(true);
    expect(j.outcome).toBe('verified');
    expect(j.requestId).toBe(id);
    expect(j.settlementTx).toBe(tx);
    expect(j.checks.map((c: { check: string; status: string }) => [c.check, c.status])).toEqual([
      ['release', 'pass'],
      ['signer', 'pass'],
      ['signature', 'pass'],
      ['binding', 'pass'],
      ['timing_and_inputs', 'pass'],
      ['settlement', 'pass'],
    ]);
    for (const c of j.checks) expect(c.link).toContain(SCAN);
  });

  it('verify of a settlement tx with no local record checks the settlement and says the proof checks were not run', async () => {
    await started();
    const id = await w.call();
    const tx = w.gw.results.get(id)!.tx!;
    rmSync(join(w.home, '.attessa', 'pending.jsonl'));
    expect(await w.verify(tx)).toBe(1);
    expect(w.row('settlement')).toMatch(PASS);
    for (const c of ['release', 'signer', 'signature', 'binding', 'timing_and_inputs']) {
      expect(w.row(c), c).toMatch(SKIP);
      expect(w.row(c), c).toContain('no proof given');
    }
    expect(w.out.join('\n')).toContain('Not fully verified: 5 checks were not run.');
  });

  it('verify of a settlement tx with a proof but no local record never passes the checks it cannot make', async () => {
    await started();
    const id = await w.call();
    const kept = w.keep(id);
    const tx = w.gw.results.get(id)!.tx!;
    rmSync(join(w.home, '.attessa', 'pending.jsonl'));
    expect(await w.verify(tx, '--proof', kept.proof, '--response', kept.response)).toBe(1);
    expect(w.row('signature')).toMatch(PASS);
    expect(w.row('release')).toMatch(PASS);
    expect(w.row('signer')).toMatch(SKIP);
    expect(w.row('binding')).toMatch(SKIP);
    expect(w.row('settlement')).toMatch(PASS);
  });

  it('verify without a proof prints the proof checks as not checked, never as passed', async () => {
    await started();
    const id = await w.call();
    expect(await w.verify(id)).toBe(1);
    expect(w.row('settlement')).toMatch(PASS);
    for (const c of ['release', 'signer', 'signature', 'binding', 'timing_and_inputs']) {
      expect(w.row(c), c).toMatch(SKIP);
      expect(w.row(c), c).toContain(SCAN);
    }
  });
});

describe('verify: one refused case for each check', () => {
  it('verify refuses a release that is not Approved for the agent', async () => {
    await started({ proof: (p) => ({ ...p, releaseId: keccak256(stringToBytes('never approved')) }) });
    const id = await w.call();
    const kept = w.keep(id);
    expect(await w.verify(id, '--proof', kept.proof, '--response', kept.response)).toBe(1);
    expect(w.row('release')).toMatch(FAIL);
    expect(w.row('release')).toContain('was not Approved');
    expect(w.row('release')).toContain(SCAN);
  });

  it('verify refuses a release that was Revoked at the settlement block', async () => {
    const revoked = keccak256(stringToBytes('revoked release'));
    await started({ proof: (p) => ({ ...p, releaseId: revoked }) });
    w.chain.approveRelease(AGENT, revoked);
    w.chain.setReleaseStatus(AGENT, revoked, 3);
    w.chain.advance(2);
    const id = await w.call();
    const kept = w.keep(id);
    expect(await w.verify(id, '--proof', kept.proof, '--response', kept.response)).toBe(1);
    expect(w.row('release')).toMatch(FAIL);
    expect(w.row('release')).toContain('(Revoked)');
  });

  it('verify refuses a signer that is not Active (never registered)', async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    await started({ signWith: other, headerSigner: other.address });
    const id = await w.call();
    const kept = w.keep(id);
    expect(await w.verify(id, '--proof', kept.proof, '--response', kept.response)).toBe(1);
    expect(w.row('signature')).toMatch(PASS);
    expect(w.row('signer')).toMatch(FAIL);
    expect(w.row('signer')).toContain('UNKNOWN_SIGNER');
  });

  it('verify refuses a signer attested for a different release', async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    await started({ signWith: other, headerSigner: other.address });
    const otherRelease = keccak256(stringToBytes('other release'));
    w.chain.approveRelease(AGENT, otherRelease);
    w.chain.registerSigner(other.address, AGENT, otherRelease, w.gw.originHash, w.operator);
    w.chain.advance(2);
    const id = await w.call();
    const kept = w.keep(id);
    expect(await w.verify(id, '--proof', kept.proof, '--response', kept.response)).toBe(1);
    expect(w.row('signer')).toMatch(FAIL);
    expect(w.row('signer')).toContain('attested for another release');
    expect(w.row('release')).toMatch(PASS);
  });

  it('verify refuses a bad proof signature (the signer field is not who signed)', async () => {
    const liar = privateKeyToAccount(generatePrivateKey());
    await started({ headerSigner: liar.address });
    const id = await w.call();
    const kept = w.keep(id);
    expect(await w.verify(id, '--proof', kept.proof, '--response', kept.response)).toBe(1);
    expect(w.row('signature')).toMatch(FAIL);
    expect(w.row('signature')).toContain('not by the signer it names');
    expect(w.row('signature')).toContain(SCAN);
  });

  it('verify refuses a proof that is not a well-formed X-Attested-Proof', async () => {
    await started();
    const id = await w.call();
    writeFileSync(join(w.home, 'bad.proof'), Buffer.from('{"not":"a proof"}').toString('base64'));
    expect(await w.verify(id, '--proof', 'bad.proof')).toBe(1);
    expect(w.row('signature')).toMatch(FAIL);
  });

  it('verify refuses a requestId that is not this call', async () => {
    await started({ proof: (p) => ({ ...p, requestId: keccak256(stringToBytes('another call')) }) });
    const id = await w.call();
    const kept = w.keep(id);
    expect(await w.verify(id, '--proof', kept.proof, '--response', kept.response)).toBe(1);
    expect(w.row('binding')).toMatch(FAIL);
    expect(w.row('binding')).toContain("requestId isn't this call's");
  });

  it('verify refuses a requestHash that is not this call\'s request', async () => {
    await started({ proof: (p) => ({ ...p, requestHash: keccak256(stringToBytes('another request')) }) });
    const id = await w.call();
    const kept = w.keep(id);
    expect(await w.verify(id, '--proof', kept.proof, '--response', kept.response)).toBe(1);
    expect(w.row('binding')).toMatch(FAIL);
    expect(w.row('binding')).toContain('requestHash');
  });

  it('verify refuses a responseHash that does not match the answer that was kept', async () => {
    await started();
    const id = await w.call();
    const kept = w.keep(id);
    writeFileSync(join(w.home, kept.response), '{"verdict":"allow","tampered":true}');
    expect(await w.verify(id, '--proof', kept.proof, '--response', kept.response)).toBe(1);
    expect(w.row('binding')).toMatch(FAIL);
    expect(w.row('binding')).toContain('responseHash');
  });

  it('verify refuses a call that never settled while its payment permission can still be used', async () => {
    await started({ paid: 'deliver_no_settle' });
    const id = await w.call('--no-wait');
    expect(await w.verify(id)).toBe(1);
    expect(w.row('settlement')).toMatch(FAIL);
    expect(w.row('settlement')).toContain('can still be used');
    expect(w.row('settlement')).toContain(SCAN);
  });

  it('verify passes settlement as not charged once the permission expired unused, and says so', async () => {
    await started({ paid: 'deliver_no_settle' });
    const id = await w.call('--no-wait');
    w.chain.advance(400);
    expect(await w.verify(id)).toBe(1); // proof checks were not run
    expect(w.row('settlement')).toMatch(PASS);
    expect(w.row('settlement')).toContain('not charged');
  });

  it('verify of a reserved call (nothing signed yet) still links its settlement row, in text and --json', async () => {
    await started();
    const id = await w.call();
    const pending = join(w.home, '.attessa', 'pending.jsonl');
    const e = JSON.parse(readFileSync(pending, 'utf8').trim().split('\n').at(-1)!);
    writeFileSync(pending, `${JSON.stringify({ ...e, state: 'reserved', nonce: null, settlementTx: null })}\n`);
    expect(await w.verify(id)).toBe(1);
    expect(w.row('settlement')).toMatch(FAIL);
    expect(w.row('settlement')).toContain('nothing was signed for this request');
    expect(w.row('settlement')).toContain(SCAN);
    expect(await w.verify(id, '--json')).toBe(1);
    const settlement = (JSON.parse(w.out.at(-1)!) as { checks: Array<{ check: string; link: string | null }> }).checks.find((c) => c.check === 'settlement')!;
    expect(settlement.link).toContain(SCAN);
  });

  it('verify refuses a settlement tx that is not this payment', async () => {
    await started();
    const id = await w.call();
    const other = w.chain.settle('0x00000000000000000000000000000000000000aa', '0x00000000000000000000000000000000000000bb', 1n, `0x${'cd'.repeat(32)}`);
    const pending = join(w.home, '.attessa', 'pending.jsonl');
    const e = JSON.parse(readFileSync(pending, 'utf8').trim().split('\n').at(-1)!);
    writeFileSync(pending, `${JSON.stringify({ ...e, settlementTx: other })}\n`);
    expect(await w.verify(id)).toBe(1);
    expect(w.row('settlement')).toMatch(FAIL);
    expect(w.row('settlement')).toContain('is not a settlement of this payment');
  });
});

describe('verify: errors and no key', () => {
  it('verify of a requestId with no record and no such transaction is requestId not found, with one next action', async () => {
    await started();
    expect(await w.verify(`0x${'12'.repeat(32)}`)).toBe(1);
    expect(w.err.join('\n')).toContain('No record of 0x1212…12');
    expect(w.err.join('\n')).toContain('Check the id, or pass the settlement transaction hash of the call.');
    w.out.length = 0;
    expect(await w.verify(`0x${'12'.repeat(32)}`, '--json')).toBe(1);
    const j = JSON.parse(w.out[0]!);
    expect(j).toMatchObject({ ok: false, error: 'request_not_found' });
    expect(j.next).toBeTruthy();
  });

  it('verify refuses a target that is not a requestId or a transaction hash', async () => {
    await started();
    expect(await w.verify('not-a-hash')).toBe(1);
    expect(w.err.join('\n')).toContain('0x followed by 64 hex characters');
  });

  it('verify never loads a key, touches the keychain, or sends or signs anything', async () => {
    await started();
    const id = await w.call();
    const kept = w.keep(id);
    const touched = w.keychain.touched;
    const calls = w.chain.calls.length;
    // A malformed wallet env would stop any command that loads a key: verify must not even look at it.
    const env = { ...w.env, ATTESSA_PRIVATE_KEY: 'definitely not a key', ATTESSA_KEYSTORE_PASSWORD: 'x' };
    w.out.length = 0;
    const code = await run(['verify', id, '--proof', kept.proof, '--response', kept.response, ...NET], w.deps(env));
    expect(code).toBe(0);
    expect(w.keychain.touched).toBe(touched);
    const used = w.chain.calls.slice(calls);
    expect(used.length).toBeGreaterThan(0);
    for (const m of used) expect(m).not.toMatch(/send|sign|estimateGas/i);
    expect(w.out.join('\n')).not.toContain('definitely not a key');
  });
});

describe('verify: Codex r1', () => {
  const V10 = 'timing_and_inputs';
  const refuses = async (behavior: Behavior, words: RegExp) => {
    await started(behavior);
    const id = await w.call();
    const kept = w.keep(id);
    expect(await w.verify(id, '--proof', kept.proof, '--response', kept.response)).toBe(1);
    expect(w.row(V10)).toMatch(FAIL);
    expect(w.row(V10)).toMatch(words);
    expect(w.out.join('\n')).not.toContain('Verified: every check passed.');
  };

  it('verify passes the V10 timing and inputs row on an honest call', async () => {
    await started();
    const id = await w.call();
    const kept = w.keep(id);
    expect(await w.verify(id, '--proof', kept.proof, '--response', kept.response)).toBe(0);
    expect(w.row(V10)).toMatch(PASS);
    expect(w.row(V10)).toContain(SCAN);
  });
  it('verify refuses a proof whose expiresAt is not issuedAt + 600 (proof_expired)', () => refuses({ proof: (p) => ({ ...p, expiresAt: p.issuedAt + 601n }) }, /expired/));
  it('verify refuses a proof whose inputsHash is not the answer\'s inputs (inputs_hash_mismatch)', () =>
    refuses({ proof: (p) => ({ ...p, inputsHash: keccak256(stringToBytes('other inputs')) }) }, /Celo data in the answer/));
  it('verify refuses inputs whose account values differ from the chain (inputs_mismatch)', () =>
    refuses({ inputs: (h) => ({ ...h, payTo: { ...(h.payTo as object), balanceWei: '1' } }) }, /doesn't match the chain/));
  it('verify refuses a proof issued far from the signing time (clock_skew)', () => refuses({ proof: (p) => ({ ...p, issuedAt: p.issuedAt - 1000n, expiresAt: p.expiresAt - 1000n }) }, /clock/));
  it('verify refuses a proof for another agent than the call was made to (agent_mismatch)', () => refuses({ proof: (p) => ({ ...p, agentId: 999n }) }, /different agent|machine's key/));

  it('verify never echoes an unreadable --response value, text or --json', async () => {
    await started();
    const id = await w.call();
    const bad = 'https://user:SENTINELCRED@example.invalid/a?token=SENTINELCRED#x';
    expect(await w.verify(id, '--response', bad)).toBe(1);
    w.out.length = 0;
    expect(await w.verify(id, '--response', bad, '--json')).toBe(1);
    expect([...w.out, ...w.err].join('\n')).not.toContain('SENTINELCRED');
    expect(JSON.parse(w.out[0]!).error).toBe('usage');
  });

  it('verify on --network local prints no public explorer link, and says so', async () => {
    await started();
    const id = await w.call();
    const kept = w.keep(id);
    w.out.length = 0;
    expect(await run(['verify', id, '--proof', kept.proof, '--response', kept.response, ...NET_LOCAL], w.deps())).toBe(0);
    expect(w.out.join('\n')).not.toContain('celoscan');
    expect(w.out.join('\n')).toContain('No public explorer for --network local');
  });
});
