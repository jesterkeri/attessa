import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { custom, keccak256, stringToBytes, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// Adversary T21 r4. Every key here is generated in-test; no real key is used.

const AGENT = 412n;
const SOURCE = 'https://github.com/acme/risk/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const RPC = 'http://127.0.0.1:1';

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
  const releaseId = keccak256(stringToBytes(`release-${Math.random()}`));
  chain.approveRelease(AGENT, releaseId, SOURCE);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, releaseId, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv4-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    origin,
    url: `${origin}/v1/evaluate`,
    home,
    /** When true, every RPC request fails as an unreachable node would. */
    rpcDown: false,
    /** Count of /v1/results requests carrying a payer signature. */
    resultFetches: 0,
    out: [] as string[],
    err: [] as string[],
    transcript: [] as string[],
    env: { ATTESSA_REGISTRY: chain.registry } as Record<string, string | undefined>,
    deps(): Deps {
      const real = chain.transport();
      const transport = custom({
        request: async (args: { method: string; params?: unknown }) => {
          if (w.rpcDown) throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:1');
          return real({ chain: undefined, retryCount: 0 }).request(args as never);
        },
      });
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
        runner: { run: async () => ({ code: 1, stdout: '', stderr: '' }) },
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes('/v1/results/')) w.resultFetches++;
          return fetch(input, init);
        }) as typeof fetch,
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
          transport,
          fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).includes('/v1/results/')) w.resultFetches++;
            return fetch(input, init);
          }) as typeof fetch,
          sleep: async (ms: number) => chain.advance(Math.max(1, ms / 1000)),
          receiptWaitMs: 2000,
          httpTimeoutMs: 5000,
        } as Deps['sdk'],
      };
    },
    cli: (...argv: string[]) => run(argv, w.deps()),
    call: (...extra: string[]) => run(['call', w.url, '--body', 'tx.json', '--network', 'local', '--rpc', RPC, ...extra], w.deps()),
    pending(): Array<Record<string, unknown>> {
      const p = join(home, '.attessa', 'pending.jsonl');
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    clear() {
      w.out.length = 0;
      w.err.length = 0;
      w.transcript.length = 0;
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
let w: W | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/** init, then one call left open (signed, never settled), as FLOWS §6 "J1 interrupted" leaves it. */
async function withOpenCall(): Promise<{ w: W; id: string }> {
  w = await world();
  expect(await w.cli('init', '--network', 'local', '--rpc', RPC)).toBe(0);
  w.gw.behavior = { paid: 'pending_no_settle' };
  expect(await w.call('--no-wait')).toBe(1);
  const id = w.pending()[0]!.requestId as string;
  expect(w.pending()[0]!.nonce).not.toBeNull();
  w.clear();
  return { w, id };
}

describe('adversary T21 r4: SDK errors the CLI now reports as "Unexpected error"', () => {
  // FLOWS §8 errors table, "rpc unavailable": "Can't reach Celo at {rpc}. Nothing was signed." → `rpc_unavailable`.
  // FLOWS §5 row 1 lists rpc_unavailable for every chain read. The SDK raises it as AttestError('rpc_unavailable');
  // `status --pending` doesn't map it, so run() turns it into the generic `unexpected` line.
  it('status --pending with the RPC down prints the FLOWS rpc_unavailable line, not "Unexpected error (AttestError)"', async () => {
    const { w } = await withOpenCall();
    w.rpcDown = true;
    expect(await w.cli('status', '--pending', '--network', 'local', '--rpc', RPC)).toBe(1);
    expect(w.err).toEqual([`Can't reach Celo at ${RPC}. Nothing was signed.`, 'Retry or set another `--rpc`.']);
  });

  it('status --pending --json with the RPC down: error code rpc_unavailable', async () => {
    const { w } = await withOpenCall();
    w.rpcDown = true;
    expect(await w.cli('status', '--pending', '--network', 'local', '--rpc', RPC, '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'rpc_unavailable' });
  });

  // FLOWS §8 "wrong network": "Your RPC is on chain {x}; this registry is on {y}." → `network_mismatch`.
  // FLOWS §10: "The CLI reads chainId from the RPC and refuses on mismatch with the configured registry."
  it('status --pending against an RPC on another chain prints the FLOWS wrong-network line', async () => {
    const { w } = await withOpenCall();
    expect(await w.cli('status', '--pending', '--network', 'mainnet', '--rpc', RPC)).toBe(1);
    expect(w.err).toEqual(['Your RPC is on chain 11142220; this registry is on 42220.', 'Set `--rpc` for 42220.']);
  });

  // Same rows for `attessa cancel`: the RPC check fails before anything is signed.
  it('cancel with the RPC down prints the FLOWS rpc_unavailable line', async () => {
    const { w, id } = await withOpenCall();
    w.rpcDown = true;
    expect(await w.cli('cancel', id, '--network', 'local', '--rpc', RPC, '--yes')).toBe(1);
    expect(w.err).toEqual([`Can't reach Celo at ${RPC}. Nothing was signed.`, 'Retry or set another `--rpc`.']);
  });

  it('cancel against an RPC on another chain prints the FLOWS wrong-network line', async () => {
    const { w, id } = await withOpenCall();
    expect(await w.cli('cancel', id, '--network', 'mainnet', '--rpc', RPC, '--yes')).toBe(1);
    expect(w.err).toEqual(['Your RPC is on chain 11142220; this registry is on 42220.', 'Set `--rpc` for 42220.']);
  });
});

describe('adversary T21 r4: --dry-run with an open call for the same input', () => {
  // FLOWS §9: "Every call can stop before signing (`--dry-run`)"; FLOWS §9 "Preview replaces undo. `--dry-run` on
  // every write and on calls (stops before signing, shows price and checks)". SPEC §8 global flag `--dry-run`.
  // With an open entry for the same input, V0 resume runs before the dry-run stop: the wallet signs the
  // X-Attest-Payer-Sig message, the CLI waits out the authorization and rewrites the ledger entry to a final state,
  // and it never shows the price or the dry-run line. A preview must not sign or change anything.
  it('a dry run signs nothing with the wallet, leaves the open entry as it was, and ends with the dry-run line', async () => {
    const { w } = await withOpenCall();
    const before = JSON.stringify(w.pending());
    const fetchesBefore = w.resultFetches;
    const code = await w.call('--dry-run');
    expect(w.resultFetches - fetchesBefore).toBe(0); // no payer-signed /v1/results request
    expect(JSON.stringify(w.pending())).toBe(before);
    expect(w.transcript).toContain('  (dry run: nothing was signed)');
    expect(code).toBe(0);
  });
});
