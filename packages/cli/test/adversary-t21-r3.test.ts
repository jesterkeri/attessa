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
import { world as sellerWorld } from './harness.ts';

// Adversary T21 r3. Every key here is generated or synthetic; no real key is used.

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

/** keytar on a headless Linux host (no Secret Service / D-Bus): it loads, but every call rejects. */
const UNAVAILABLE_KEYCHAIN: Keychain = {
  getPassword: async () => {
    throw new Error('Cannot autolaunch D-Bus without X11 $DISPLAY');
  },
  setPassword: async () => {
    throw new Error('Cannot autolaunch D-Bus without X11 $DISPLAY');
  },
};

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
  const home = mkdtempSync(join(tmpdir(), 'attessa-adv3-'));
  const w = {
    chain,
    gw,
    origin,
    host: origin.replace(/^https?:\/\//, ''),
    payTo,
    home,
    url: `${origin}/v1/evaluate`,
    keychain: new MemKeychain() as Keychain,
    env: { ATTESSA_REGISTRY: chain.registry } as Record<string, string | undefined>,
    transcript: [] as string[],
    err: [] as string[],
    /** Called before each stdout line is recorded; may throw (a closed or failing stdout). */
    onOut: (_l: string): void => {},
    deps(): Deps {
      return {
        io: {
          out: (l) => {
            w.onOut(l);
            w.transcript.push(l);
          },
          err: (l) => void (w.err.push(l), w.transcript.push(l)),
          confirm: async () => true,
        },
        env: w.env,
        cwd: home,
        home,
        keychain: w.keychain,
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
        sdk: { transport: chain.transport(), sleep: async (ms: number) => chain.advance(Math.max(1, ms / 1000)), receiptWaitMs: 2000, httpTimeoutMs: 5000 },
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
  return w;
}

type W = Awaited<ReturnType<typeof world>>;
let w: W | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

describe('adversary T21 r3: an unavailable OS keychain', () => {
  // FLOWS §5 row 25 (attessa init): "`keychain_unavailable` → falls back to `--keystore` with a printed instruction".
  // keytar that loads but can't reach a Secret Service (any headless Linux box, the EC2 host included) is an
  // unavailable keychain, exactly like no keytar at all.
  it('init with a keychain that rejects every call prints the keychain_unavailable instruction, not a bare failure', async () => {
    w = await world();
    w.keychain = UNAVAILABLE_KEYCHAIN;
    expect(await w.cli('init', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(1);
    expect(w.err).toEqual([
      'No OS keychain is available, so no wallet was created.',
      'Set ATTESSA_PRIVATE_KEY or pass --keystore <file> (password in ATTESSA_KEYSTORE_PASSWORD).',
    ]);
  });

  // FLOWS line 840: "Reading doesn't require a wallet. `attessa status`, `resolve` and liveness are reads."
  it('status <origin> is a read: it works when the keychain is unavailable', async () => {
    w = await world();
    w.keychain = UNAVAILABLE_KEYCHAIN;
    expect(await w.cli('status', w.origin, '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    expect(w.transcript[0]).toBe(`${w.host}: agent 412, endpoint active, pays ${w.payTo}`);
  });

  // Same FLOWS line: a read needs no wallet, so a broken ATTESSA_PRIVATE_KEY (meant for paying) can't block it.
  it('status <origin> is a read: it works when ATTESSA_PRIVATE_KEY is malformed', async () => {
    w = await world();
    w.env.ATTESSA_PRIVATE_KEY = '0x1234';
    expect(await w.cli('status', w.origin, '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    expect(w.transcript[0]).toBe(`${w.host}: agent 412, endpoint active, pays ${w.payTo}`);
  });
});

describe('adversary T21 r3: --dry-run never signs', () => {
  // SPEC §8 global flag `--dry-run`; FLOWS §8 attessa call row: "`--dry-run` (stops before signing)".
  // The CLI decides to stop at the end of its 'authorizing' handler, after printing four lines. If printing fails
  // (stdout gone), the SDK swallows the handler's throw as "no answer" and goes on to sign and pay.
  it('a failing stdout during the price lines does not turn a dry run into a payment', async () => {
    w = await world();
    expect(await w.cli('init', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    w.onOut = (l) => {
      if (l.startsWith('Price:') || /price/i.test(l)) throw new Error('EPIPE: broken pipe, write');
    };
    await w.call('--dry-run').catch(() => 1);
    expect(w.gw.paid).toHaveLength(0);
    expect(w.pending().filter((e) => e.nonce !== null)).toHaveLength(0);
  });
});

describe('adversary T21 r3: owner and operator key errors', () => {
  // SPEC §7 key storage: "Never printed". AGENTS.md: never print a private key. The buyer path already maps a key
  // above the curve order to a fixed reason (sdk keys.ts toAccount); the owner/operator path (context.ts loadAccount)
  // lets viem's message out, and viem quotes the key's value in decimal. The error also escapes run() as a raw throw,
  // so bin.ts prints it to stderr and `--json` gets no {"ok":false} object.
  it('ATTESSA_PRIVATE_KEY above the curve order: exit 1 with a fixed line, and the value is not printed', async () => {
    const s = sellerWorld();
    const key = `0x${'f'.repeat(64)}`;
    s.env.ATTESSA_PRIVATE_KEY = key;
    const decimal = BigInt(key).toString();
    let thrown: unknown;
    const code = await s.cli('endpoint', 'retire', '--origin', 'https://risk.example', '--network', 'local', '--rpc', 'http://127.0.0.1:1', '--json').catch((e: unknown) => {
      thrown = e;
      return -1;
    });
    const printed = [...s.out, ...s.err, thrown instanceof Error ? thrown.message : ''].join('\n');
    expect(printed).not.toContain(decimal);
    expect(printed).not.toContain(key.slice(2));
    expect(code).toBe(1);
    expect(JSON.parse(s.out.at(-1) ?? '{}')).toMatchObject({ ok: false });
  });
});
