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

// Adversary T21 r39: a call the gateway refused (a well-formed §10 body, 502 proof_rejected{response_hash_mismatch}),
// left open with --no-wait. The first run's evidence row says `refused` / `proof_rejected`. Re-running the same input
// with --no-wait resumes it (V0); the gateway now serves a 200 from /v1/results with no settlement on chain, so
// settleAndVerify ends it `uncertain`, which finish() turns back into `refused` (the stored refusal is kept in the
// ledger) but from an empty `fields`, so the result and the new evidence row carry no code at all.
// SPEC.md:620 (V9): a 4xx/5xx with a well-formed §10 body "→ `refused` (+ code)"; SPEC.md:640: the evidence row has `code`.
// The same resumed entry reported through finalize's no-wait pass (no answer served) keeps its code (current()).

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
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv39-'));
  const keychain = new MemKeychain();
  const w = {
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
    evidence(): Array<Record<string, unknown>> {
      return readFileSync(join(home, '.attessa', 'evidence.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
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

/** The one `--json` object a run prints (run() gathers its lines into it). */
function outcomeJson(transcript: string[]): Record<string, unknown> {
  return JSON.parse(transcript.at(-1)!) as Record<string, unknown>;
}

describe('T21 adversary r39: a refused call resumed with --no-wait, answered with no settlement on chain', () => {
  it('keeps its refusal code in the result and in the new evidence row', async () => {
    w = await world();
    // Run 1: the gateway refuses with a §10 body; --no-wait keeps the call open.
    w.gw.behavior = { paid: 'refuse' };
    expect(await w.call('--no-wait')).toBe(1);
    const [first] = w.pending();
    expect(first?.state).toBe('refused');
    const id = first!.requestId as `0x${string}`;
    const before = w.evidence().filter((r) => r.requestId === id);
    expect(before.map((r) => [r.outcome, r.code])).toEqual([['refused', 'proof_rejected']]);

    // The gateway now serves an answer for that request (no proof, no PAYMENT-RESPONSE tx), with nothing on chain.
    w.gw.results.set(id, { status: 'settled', body: new TextEncoder().encode('{"verdict":"allow"}'), proofHeader: null, tx: null });

    // Run 2: the same input, --no-wait again. V0 resumes the refused entry.
    w.transcript.length = 0;
    const code = await w.call('--no-wait', '--json');
    const result = outcomeJson(w.transcript);
    expect((result.lines as string[]).join('\n')).toContain('Resuming it instead of paying again.');
    expect(w.gw.paid.length).toBe(1); // never paid twice
    expect(code).toBe(1);
    expect(w.pending()[0]?.state).toBe('refused'); // still undecided; the ledger keeps the refusal

    const added = w.evidence().filter((r) => r.requestId === id).slice(before.length);
    // Every refused row for this call names why it was refused, as the first one does.
    expect(added.map((r) => [r.outcome, r.code])).toEqual(added.map(() => ['refused', 'proof_rejected']));
    // The CLI's machine result for this refused call carries its code, as the no-answer resume below does.
    expect({ outcome: result.outcome, code: result.code }).toEqual({ outcome: 'refused', code: 'proof_rejected' });
  });

  it('control: the same resume with no answer served reports the code', async () => {
    w = await world();
    w.gw.behavior = { paid: 'refuse' };
    expect(await w.call('--no-wait')).toBe(1);
    w.transcript.length = 0;
    expect(await w.call('--no-wait', '--json')).toBe(1);
    const result = outcomeJson(w.transcript);
    expect((result.lines as string[]).join('\n')).toContain('Resuming it instead of paying again.');
    expect({ outcome: result.outcome, code: result.code }).toEqual({ outcome: 'refused', code: 'proof_rejected' });
  });
});
