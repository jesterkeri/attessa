import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEPLOYMENTS } from '@attessa/core';
import { decodeFunctionData, encodeFunctionData, parseTransaction, slice, size, type Address, type Hex, type TransactionSerialized } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY_ABI } from '../src/abi.ts';
import { AGENT, ORIGIN, onboarded, world, type World } from './harness.ts';
import { IDENTITY } from './fake-chain.ts';

// Change 2: every non-x402 transaction the CLI sends on Celo mainnet carries the Loops ERC-8021 data suffix
// (Schema 0, code from env LOOPS_ATTRIBUTION_TAG). The tag below is synthetic.

const TAG = 'celo_test1234';
const SUFFIX = '0x63656c6f5f7465737431323334' + '0d00' + '80218021802180218021802180218021';
const URI = 'https://example.org/agent.json';
const REGISTER = ['agent', 'register', '--name', 'Acme risk check', '--uri', URI, '--yes'];
const PLAIN = encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'register', args: [URI] });

// The mainnet pin for the identity registry is replaced by the fake's address for this file only (one fork per file).
(DEPLOYMENTS.celo as { identityRegistry: string }).identityRegistry = IDENTITY;

let w: World;
beforeEach(() => {
  w = world();
  onboarded(w);
  w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
});

const mainnet = (tag: string | null = TAG) => {
  w.chain.chainId = 42220;
  if (tag === null) delete w.env.LOOPS_ATTRIBUTION_TAG;
  else w.env.LOOPS_ATTRIBUTION_TAG = tag;
};
const sentData = (): Hex[] => w.chain.sent.map((raw) => parseTransaction(raw as TransactionSerialized).data!);

describe('where the suffix goes', () => {
  it('sepolia: no suffix, even with the variable set', async () => {
    w.env.LOOPS_ATTRIBUTION_TAG = TAG;
    expect(await w.cli(...REGISTER, '--network', 'sepolia')).toBe(0);
    expect(sentData()).toEqual([PLAIN]);
  });

  it('local on a chain that is not 42220: no suffix, even with the variable set', async () => {
    w.env.LOOPS_ATTRIBUTION_TAG = TAG;
    expect(await w.cli(...REGISTER, '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    expect(sentData()).toEqual([PLAIN]);
    expect(parseTransaction(w.chain.sent[0] as TransactionSerialized).chainId).toBe(11142220);
  });

  // Review r1 finding 1: the decision follows the verified chain id, not the --network label.
  it('local on a RPC that reports 42220: tagged, and the signed chain id is the verified 42220', async () => {
    mainnet();
    expect(await w.cli(...REGISTER, '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    expect(sentData()).toEqual([`${PLAIN}${SUFFIX.slice(2)}`]);
    expect(parseTransaction(w.chain.sent[0] as TransactionSerialized).chainId).toBe(42220);
  });

  it('local on 42220 with no tag: refused before anything is signed or asked', async () => {
    mainnet(null);
    expect(await w.cli(...REGISTER.slice(0, -1), '--network', 'local', '--rpc', 'http://127.0.0.1:1', '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'no_attribution_tag' });
    expect(w.chain.sent).toHaveLength(0);
    expect(w.chain.calls.map((c) => c.method)).not.toContain('eth_sendRawTransaction');
  });

  it('local on 42220 with no tag: --dry-run prints the missing-tag note', async () => {
    mainnet(null);
    delete w.env.ATTESSA_PRIVATE_KEY;
    expect(await w.cli(...REGISTER.slice(0, -1), '--network', 'local', '--rpc', 'http://127.0.0.1:1', '--dry-run')).toBe(0);
    expect(w.out.join('\n')).toMatch(/LOOPS_ATTRIBUTION_TAG.*not set/);
  });

  it('local on 42220 with no tag: a plan prints no calldata, since sent by hand it could never be credited', async () => {
    mainnet(null);
    delete w.env.ATTESSA_PRIVATE_KEY;
    expect(await w.cli(...REGISTER.slice(0, -1), '--network', 'local', '--rpc', 'http://127.0.0.1:1', '--dry-run')).toBe(0);
    expect(w.out.join('\n')).not.toContain('calldata');
    expect(w.out.join('\n')).not.toContain(PLAIN);
  });

  it('a keyless plan simulates register from a non-zero sender: ERC-721 reverts a mint to the zero address on the real registry', async () => {
    mainnet();
    delete w.env.ATTESSA_PRIVATE_KEY;
    expect(await w.cli(...REGISTER.slice(0, -1), '--network', 'mainnet', '--dry-run')).toBe(0);
    const sims = w.chain.calls.filter((c) => c.method === 'eth_call' || c.method === 'eth_estimateGas').map((c) => c.params[0] as { to?: string; from?: string });
    const toIdentity = sims.filter((s) => s.to?.toLowerCase() === IDENTITY);
    expect(toIdentity.length).toBeGreaterThan(0);
    for (const s of toIdentity) expect(BigInt(s.from ?? '0x0')).not.toBe(0n);
    expect(w.out.join('\n')).toContain(`calldata ${PLAIN}${SUFFIX.slice(2)}`);
  });

  it('the signed chain id is the verified one: a labelled-mainnet RPC that reports another chain is refused, nothing signed', async () => {
    w.env.LOOPS_ATTRIBUTION_TAG = TAG; // the fake reports 11142220
    expect(await w.cli(...REGISTER, '--network', 'mainnet')).toBe(1);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('mainnet with the variable set: the suffix is the last bytes, and the call still decodes and is accepted', async () => {
    mainnet();
    expect(await w.cli(...REGISTER, '--network', 'mainnet')).toBe(0);
    const [data] = sentData();
    expect(data).toBe(`${PLAIN}${SUFFIX.slice(2)}`);
    expect(slice(data!, size(data!) - size(SUFFIX as Hex))).toBe(SUFFIX);
    expect(decodeFunctionData({ abi: IDENTITY_ABI, data: data! })).toEqual(decodeFunctionData({ abi: IDENTITY_ABI, data: PLAIN }));
    expect(w.out.join('\n')).toMatch(/Registered/); // the fake chain executed the tagged call and minted the agent
  });

  it('every owner/operator send on mainnet is tagged (registry commands)', async () => {
    mainnet();
    w.env.ATTESSA_REGISTRY = (await import('./fake-chain.ts')).REGISTRY;
    expect(await w.cli('endpoint', 'retire', '--origin', ORIGIN, '--yes', '--network', 'mainnet')).toBe(0);
    expect(await w.cli('release', 'deprecate', w.rid, '--agent', String(AGENT), '--yes', '--network', 'mainnet')).toBe(0);
    const all = sentData();
    expect(all).toHaveLength(2);
    for (const d of all) expect(d.endsWith(SUFFIX.slice(2))).toBe(true);
  });
});

describe('mainnet without the variable', () => {
  it('refuses before anything is sent, with a message and one next action', async () => {
    mainnet(null);
    expect(await w.cli(...REGISTER, '--network', 'mainnet', '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'no_attribution_tag' });
    expect(w.chain.sent).toHaveLength(0);
    expect(w.chain.calls.map((c) => c.method)).not.toContain('eth_sendRawTransaction');
    w.out.length = 0;
    expect(await w.cli(...REGISTER, '--network', 'mainnet')).toBe(1);
    expect(w.err.join('\n')).toContain('LOOPS_ATTRIBUTION_TAG');
    expect(w.err).toHaveLength(2); // the message, then one next action
  });

  it('--dry-run still plans, and says the tag is missing', async () => {
    mainnet(null);
    delete w.env.ATTESSA_PRIVATE_KEY;
    expect(await w.cli(...REGISTER.slice(0, -1), '--network', 'mainnet', '--dry-run')).toBe(0);
    expect(w.out.join('\n')).toMatch(/LOOPS_ATTRIBUTION_TAG.*(missing|not set)/i);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('--dry-run with the tag set shows the tagged calldata', async () => {
    mainnet();
    expect(await w.cli(...REGISTER.slice(0, -1), '--network', 'mainnet', '--dry-run')).toBe(0);
    expect(w.out.join('\n')).toContain(`${PLAIN}${SUFFIX.slice(2)}`);
  });

  it('a read-only command is not blocked', async () => {
    mainnet(null);
    expect(await w.cli('status', '--agent', String(AGENT), '--network', 'mainnet')).toBe(0);
  });

  it('a malformed tag is a usage error before anything is sent', async () => {
    mainnet('Not A Tag!');
    expect(await w.cli(...REGISTER, '--network', 'mainnet')).toBe(1);
    expect(w.err.join('\n')).toContain('LOOPS_ATTRIBUTION_TAG');
    expect(w.chain.sent).toHaveLength(0);
  });
});

/** Fails when a new place signs a transaction without being listed here (and tagged), so no send path can skip the tag. */
describe('every send path is accounted for', () => {
  const SEND_SITES: Record<string, string> = {
    'cli/src/tx.ts': 'send(): every seller/owner/operator write, through planOrSend',
    'sdk/src/client.ts': 'sendCancel(): the buyer cancelAuthorization transaction (attessa cancel)',
  };
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });

  it('only the listed files sign a transaction, and each applies withAttribution to its calldata', () => {
    const root = join(__dirname, '..', '..');
    const found = ['cli', 'sdk', 'core', 'gateway', 'seller-host']
      .flatMap((p) => walk(join(root, p, 'src')))
      .filter((f) => /\.signTransaction\(|sendTransaction\(|writeContract\(|eth_sendRawTransaction/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(root.length + 1).replaceAll('\\', '/'));
    expect(found.sort()).toEqual(Object.keys(SEND_SITES).sort());
    for (const f of found) expect(readFileSync(join(root, f), 'utf8'), f).toMatch(/withAttribution\(/);
  });
});
void (null as unknown as Address);
