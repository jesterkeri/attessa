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

// Adversary T21 r37: a call the gateway refused (a well-formed §10 body, so the entry is `refused`), left open with
// --no-wait. Re-running the same input resumes it (V0). The gateway now serves a 200 from /v1/results with no settlement
// on chain, so settleAndVerify finds none and, since r36, waits through finalize. During that wait the gateway settles
// the authorization anyway and then holds no result. SPEC §7 (SPEC.md:635): "if found, first call getResult ... no
// result and the call was `refused` -> `settled_after_refusal`; no result and the call was `uncertain` ->
// `paid_but_rejected{missing_proof}`". The call was refused; nothing but the SDK's own rewrite made it uncertain.

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
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv37-'));
  const keychain = new MemKeychain();
  const w = {
    onSleep: undefined as (() => void) | undefined,
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
        sdk: { transport: chain.transport(), sleep: async (ms: number) => {
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

describe('T21 adversary r37: a refused call resumed, answered with no settlement, then settled during the wait', () => {
  it('ends settled_after_refusal (the call was refused), not paid_but_rejected{missing_proof}', async () => {
    w = await world();
    // Run 1: the gateway refuses with a §10 body (502 proof_rejected{response_hash_mismatch}); --no-wait keeps it open.
    w.gw.behavior = { paid: 'refuse' };
    expect(await w.call('--no-wait')).toBe(1);
    const [first] = w.pending();
    expect(first?.state).toBe('refused');
    const id = first!.requestId as `0x${string}`;
    const paid = w.gw.paid[0]!;
    const auth = (paid.payload.payload as { authorization: { value: string; nonce: `0x${string}` } }).authorization;

    // The gateway now serves an answer for that request (no proof, no PAYMENT-RESPONSE tx), with nothing on chain.
    w.gw.results.set(id, { status: 'settled', body: new TextEncoder().encode('{"verdict":"allow"}'), proofHeader: null, tx: null });
    // During the SDK's wait for expiry, the gateway settles the authorization and stops serving the answer.
    let settled = false;
    w.onSleep = () => {
      if (settled) return;
      settled = true;
      w!.chain.settle(paid.ctx.payer, w!.gw.payTo, BigInt(auth.value), auth.nonce);
      w!.gw.behavior = { paid: 'refuse', noResults: true };
    };

    // Run 2: the same input, default wait. V0 resumes the refused entry.
    w.transcript.length = 0;
    const code = await w.call();
    const t = w.transcript.join('\n');
    expect(t).toContain('Resuming it instead of paying again.');
    expect(settled).toBe(true);
    expect(w.gw.paid.length).toBe(1); // never paid twice

    const evidence = readFileSync(join(w.home, '.attessa', 'evidence.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const last = evidence.filter((r) => r.requestId === id).at(-1)!;
    // SPEC.md:635: settled, no result, and the call was refused -> settled_after_refusal (FLOWS §6 J2 variant copy).
    expect({ ledger: w.pending()[0]?.state, evidence: last.outcome }).toEqual({ ledger: 'settled_after_refusal', evidence: 'settled_after_refusal' });
    expect(t).toContain('Warning: the service refused this call, but your payment permission was used anyway: 0.02 USDC');
    expect(t).not.toContain("but the answer didn't check out  (paid_but_rejected)");
    expect(code).toBe(1);
  });
});
