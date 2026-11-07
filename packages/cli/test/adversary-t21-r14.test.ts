import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// T21 adversary r14. A call the gateway refused, whose payment permission it then used anyway (`refuse_but_settle`),
// made with --no-wait so it is left `refused`. `attessa cancel <id>` finds the AuthorizationUsed + Transfer on chain
// ("Too late to cancel"), then asks the gateway for the answer, and the gateway says it has none (its §10
// `result_not_found`). SPEC §7 "refused / uncertain -> final": settled on chain, "no result and the call was refused
// -> settled_after_refusal". FLOWS §8 "settled after refusal": "Warning: the service refused this call, but your
// payment permission was used anyway (tx {h})." -> report_gateway. The CLI instead takes the payment-found branch:
// "The answer isn't confirmed yet. attessa status --pending checks again and fetches it." (--json: `uncertain` ->
// `get_result`), promising an answer the gateway just said does not exist and withholding the gateway-fault warning.
// The world below is adversary-t21-r13.test.ts's, unchanged.

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

async function buyerWorld() {
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
  const home = mkdtempSync(join(tmpdir(), 'attessa-cli-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    home,
    payTo,
    url: `${origin}/v1/evaluate`,
    transcript: [] as string[],
    out: [] as string[],
    err: [] as string[],
    data: [] as unknown[],
    env: { ATTESSA_REGISTRY: chain.registry } as Record<string, string | undefined>,
    deps(): Deps {
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
      await gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, 'tx.json'), JSON.stringify({ chainId: String(chain.chainId), payTo, asset: chain.asset, amount: '20000' }));
  return w;
}

let w: Awaited<ReturnType<typeof buyerWorld>>;
afterEach(async () => w?.close());

const RPC = 'http://127.0.0.1:1';
const LOCAL = ['--network', 'local', '--rpc', RPC];

describe('a refused call that settled anyway, the gateway holding no answer for it', () => {
  it('attessa cancel ends settled_after_refusal with its warning, never "fetches it"', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    w.gw.behavior = { paid: 'refuse_but_settle' }; // proof_rejected{response_hash_mismatch}, then settles
    expect(await w.cli('call', w.url, '--body', 'tx.json', ...LOCAL, '--no-wait')).toBe(1);
    const id = w.pending()[0]!.requestId as Hex;
    expect(w.pending()[0]).toMatchObject({ requestId: id, state: 'refused' });

    w.transcript.length = 0;
    expect(await w.cli('cancel', id, ...LOCAL, '--yes')).toBe(1);
    const tx = w.pending()[0]!.settlementTx as string;
    // Preconditions: the chain shows the settlement, and cancel took the "Too late to cancel" path.
    expect(tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.transcript[0]).toMatch(/^Too late to cancel: the payment went through/);

    const text = w.transcript.join('\n');
    expect(text).not.toMatch(/fetches it/);
    expect(text).toMatch(/Warning: the service refused this call, but your payment permission was used anyway/);
  }, 60_000);
});
