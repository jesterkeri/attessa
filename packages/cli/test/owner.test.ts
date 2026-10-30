import { originHash } from '@attessa/core';
import { decodeFunctionData, parseTransaction, toHex, type TransactionSerialized } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY_ABI } from '../src/abi.ts';
import { REGISTRY } from './fake-chain.ts';
import { AGENT, ORIGIN, world, type World } from './harness.ts';

const SRC = 'https://github.com/acme/risk/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
let w: World;

function measurements(w: World): void {
  w.files.set(
    'build/measurements.json',
    Buffer.from(JSON.stringify({ Measurements: { HashAlgorithm: 'Sha384 { ... }', PCR0: w.pcrs[0].toString('hex'), PCR1: w.pcrs[1].toString('hex'), PCR2: w.pcrs[2].toString('hex') } })),
  );
}

beforeEach(() => {
  w = world();
  measurements(w);
});

describe('seller: attessa release approve (FLOWS §6 J3)', () => {
  const approve = (...extra: string[]) => w.cli('release', 'approve', '--agent', '412', '--from-build', 'build/measurements.json', '--source', SRC, ...extra);

  it('without a key: prints the FLOWS lines, the calldata and an eth_call simulation from the owner, and sends nothing', async () => {
    expect(await approve()).toBe(0);
    expect(w.out[0]).toBe(`Approving the build made from acme/risk @ a1b2c3d for agent 412  (release ${w.rid.slice(0, 6)}…${w.rid.slice(-2)}; PCR0-2 read from the build output)`);
    // 200,000 gas × 25 gwei = 0.005 CELO → "about 0.01 CELO"
    expect(w.out[1]).toBe(`  Buyers will see "owner says it's built from acme/risk @ a1b2c3d" (attessa can't check that claim). One transaction, about 0.01 CELO.  [approve/cancel]`);
    expect(w.out[2]).toBe(`  (tx 1/1: approveRelease; from ${w.owner} to ${REGISTRY}; eth_call ok, gas 200000)`);
    const data = w.out[3]!.match(/^ {2}\(calldata (0x[0-9a-f]+)\)$/)![1] as `0x${string}`;
    const call = decodeFunctionData({ abi: REGISTRY_ABI, data });
    expect(call.functionName).toBe('approveRelease');
    expect(call.args).toEqual([AGENT, toHex(w.pcrs[0]), toHex(w.pcrs[1]), toHex(w.pcrs[2]), SRC]);
    expect(w.out.at(-1)).toMatch(/no ATTESSA_PRIVATE_KEY: nothing was sent/);
    expect(w.chain.sent).toHaveLength(0);
    expect(w.chain.calls.some((c) => c.method === 'eth_call' && (c.params[0] as { from?: string }).from === w.owner)).toBe(true);
  });

  it('--dry-run with a key still sends nothing', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expect(await approve('--dry-run')).toBe(0);
    expect(w.out.at(-1)).toBe('  (dry run: nothing was sent)');
    expect(w.chain.sent).toHaveLength(0);
  });

  it('with the owner key and confirmation: signs one approveRelease for this chain and prints the success line', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expect(await approve()).toBe(0);
    expect(w.chain.sent).toHaveLength(1);
    const tx = parseTransaction(w.chain.sent[0] as TransactionSerialized);
    expect(tx.chainId).toBe(11142220);
    expect(tx.to).toBe(REGISTRY);
    expect(tx.gas! < 16_777_216n).toBe(true);
    expect(w.out.at(-1)).toMatch(/^Approved \(tx 0x[0-9a-f]{4}…[0-9a-f]{2}\)\. Next: attessa endpoint add\.$/);
    expect(w.chain.releases.get(`${AGENT}:${w.rid}`)).toBe(1);
    // the key itself never reaches the output
    expect([...w.out, ...w.err].join('\n')).not.toContain(w.ownerKey.slice(2));
  });

  it('cancelling at the prompt sends nothing', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    w.confirmAnswer = false;
    expect(await approve()).toBe(1);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('refuses a key that is not the agent owner, naming both (not_owner)', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    expect(await approve('--yes')).toBe(1);
    expect(w.err).toEqual([
      `Only agent 412's owner (${w.owner}) can do this; this command was signed by ${w.operator}.`,
      'Run it from the owner wallet (--keystore or ATTESSA_PRIVATE_KEY).',
    ]);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('refuses a build that is already approved (release_exists)', async () => {
    w.chain.releases.set(`${AGENT}:${w.rid}`, 1);
    expect(await approve()).toBe(1);
    expect(w.err).toEqual([`This build is already approved for agent 412 (release ${w.rid.slice(0, 6)}…${w.rid.slice(-2)}).`]);
  });

  it('refuses a measurements file that is not nitro-cli output (invalid_pcr)', async () => {
    w.files.set('build/measurements.json', Buffer.from('{"PCR0":"00"}'));
    expect(await approve()).toBe(1);
    expect(w.err).toEqual([
      "Couldn't read the build measurements in build/measurements.json. It should be the JSON that `nitro-cli build-enclave` prints.",
      'Pass the file nitro-cli wrote.',
    ]);
    expect(w.chain.calls).toHaveLength(0);
  });

  it('refuses an RPC on another chain (network_mismatch) and an unreachable RPC (rpc_unavailable)', async () => {
    w.chain.chainId = 42220;
    expect(await approve()).toBe(1);
    expect(w.err).toEqual(['Your RPC is on chain 42220; this registry is on 11142220.', 'Set `--rpc` for 11142220.']);
    w.err.length = 0;
    w.chain.down = true;
    expect(await approve()).toBe(1);
    expect(w.err).toEqual(["Can't reach Celo at https://forno.celo-sepolia.celo-testnet.org. Nothing was signed.", 'Retry or set another `--rpc`.']);
  });

  it('accepts global flags before the command words', async () => {
    expect(await w.cli('--dry-run', '--network', 'sepolia', 'release', 'approve', '--agent', '412', '--from-build', 'build/measurements.json', '--source', SRC)).toBe(0);
    expect(w.out.at(-1)).toBe('  (dry run: nothing was sent)');
  });

  it('--json prints one object with the machine code', async () => {
    w.chain.releases.set(`${AGENT}:${w.rid}`, 1);
    expect(await approve('--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'release_exists' });
  });
});

describe('seller: attessa endpoint add (FLOWS §6 J3)', () => {
  const add = (...extra: string[]) => w.cli('endpoint', 'add', '--agent', '412', '--origin', ORIGIN, '--pay-to', '0x00000000000000000000000000000000000000fe', ...extra);

  it('prints the FLOWS line and plans addEndpoint with the operator defaulting to the signing wallet', async () => {
    expect(await add()).toBe(0);
    expect(w.out[0]).toBe("Buyers of risk.example will pay 0x0000…fe and only accept answers from agent 412's approved builds. One transaction, about 0.01 CELO.  [add/cancel]");
    const data = w.out.find((l) => l.startsWith('  (calldata '))!.slice(12, -1) as `0x${string}`;
    const call = decodeFunctionData({ abi: REGISTRY_ABI, data });
    expect(call.functionName).toBe('addEndpoint');
    expect((call.args as unknown[])[1]).toBe(ORIGIN);
    expect(((call.args as unknown[])[3] as string).toLowerCase()).toBe(w.owner);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('sends with the owner key and an explicit operator, then prints "Added (tx …)."', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expect(await add('--operator', w.operator, '--yes')).toBe(0);
    expect(w.out.at(-1)).toMatch(/^Added \(tx 0x[0-9a-f]{4}…[0-9a-f]{2}\)\.$/);
    expect(w.chain.endpoints.get(originHash(ORIGIN))).toMatchObject({ agentId: AGENT, operator: w.operator, status: 1 });
  });

  it('refuses an origin with a path or uppercase (invalid_origin), before any chain call', async () => {
    for (const bad of ['https://risk.example/v1', 'https://Risk.example', 'http://risk.example']) {
      w.err.length = 0;
      expect(await w.cli('endpoint', 'add', '--agent', '412', '--origin', bad, '--pay-to', '0x00000000000000000000000000000000000000fe')).toBe(1);
      expect(w.err).toEqual(['Use just the scheme and host, like https://risk.example (no path, lowercase).']);
    }
    expect(w.chain.calls).toHaveLength(0);
  });

  it('refuses an origin another agent holds (origin_taken)', async () => {
    w.chain.endpoints.set(originHash(ORIGIN), { agentId: 7n, payTo: '0x00000000000000000000000000000000000000fe', operator: w.operator, status: 1 });
    expect(await add()).toBe(1);
    expect(w.err).toEqual(['https://risk.example is already registered to agent 7.', "Use a different origin or ask agent 7's owner to retire it."]);
  });
});

describe('seller --help (FLOWS §6 J3)', () => {
  it('prints the seller overview', async () => {
    expect(await w.cli('seller', '--help')).toBe(0);
    expect(w.out).toEqual([
      "Sell an API that buyers can check before paying: you approve a build of your code, run it in a sealed AWS machine, and register that machine's key on Celo.",
      '  Steps: agent register → enclave build → release approve → endpoint add → enclave start → signer register',
    ]);
  });
});
