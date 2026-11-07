import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, toEventSelector, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// Adversary T21 r40: the RPC's log index lags its state. A refused call (refuse_but_settle: the facilitator settles
// anyway) waits for the expiry check; past validBefore + 5 authorizationState reads true, but eth_getLogs has no
// AuthorizationUsed yet. finalize asks again 20 times, then returns current(): `refused`, no settlementTx. The CLI ends
// on its stillOpen line, "your payment permission expires unused at {t} UTC unless the gateway used it ... attessa
// cancel {id} voids it now", for a permission the chain has just read as used, and `attessa cancel` then answers that
// it was already used or cancelled. SPEC.md:635 (state true past expiry: used, never "expires unused"); FLOWS.md:832
// (one next action, which must be one that works); packages/cli/src/copy.ts:388-389 (stillOpen is "never used once a
// settlement is known (the permission was used; cancel can't void it)").

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
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv40-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    home,
    url: `${origin}/v1/evaluate`,
    transcript: [] as string[],
    deps(): Deps {
      return {
        io: { out: (l) => void w.transcript.push(l), err: (l) => void w.transcript.push(l), confirm: async () => true },
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

/** The RPC's log index lags: eth_getLogs leaves out AuthorizationUsed, while authorizationState already reads true. */
function hideUsedLogs(chain: FakeChain): void {
  const used = toEventSelector('AuthorizationUsed(address,bytes32)');
  const orig = chain.request.bind(chain);
  chain.request = async (method: string, params: unknown[] = []) => {
    const r = await orig(method, params);
    if (method === 'eth_getLogs') return (r as Array<{ topics: string[] }>).filter((l) => l.topics[0] !== used);
    return r;
  };
}

describe('T21 adversary r40: the chain reads the permission as used, but no AuthorizationUsed log has shown up yet', () => {
  it('a refused call does not end telling the buyer the permission may expire unused and that cancel voids it', async () => {
    w = await world();
    // The gateway refuses with a §10 body but its facilitator settles anyway (FLOWS settled_after_refusal).
    w.gw.behavior = { paid: 'refuse_but_settle' };
    hideUsedLogs(w.chain);
    const code = await w.call();
    const [entry] = w.pending();
    const id = entry!.requestId as `0x${string}`;
    // The chain itself says the authorization is used: the facilitator's transferWithAuthorization landed.
    expect(w.chain.authUsed(entry!.payer as Address, entry!.nonce as `0x${string}`)).toBe(true);
    expect(code).toBe(1);
    const last = w.transcript.at(-1)!;
    // The SDK read authorizationState == true past validBefore + 5: the permission did not and will not expire unused,
    // and cancel can't void it.
    expect(last).not.toContain(`attessa cancel ${id} voids it now`);
    expect(last).not.toContain('expires unused at');

    // The next action it gave fails: the cancel it names can't void the permission.
    w.transcript.length = 0;
    expect(await w.cli('cancel', id, '--network', 'local', '--rpc', 'http://127.0.0.1:1', '--yes')).toBe(1);
    expect(w.transcript.join('\n')).toContain("Your payment permission was already used or cancelled, but Celo doesn't show which yet.");
  });
});
