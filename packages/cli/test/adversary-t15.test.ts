import { DEPLOYMENTS, originHash } from '@attessa/core';
import { decodeFunctionData, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY_ABI } from '../src/abi.ts';
import { REGISTRY } from './fake-chain.ts';
import { AGENT, ORIGIN, attestation, onboarded, world, type World } from './harness.ts';

/**
 * Adversary pass on T15 (CLI side). Every chain here is the in-process FakeChain; keys are throwaway
 * `generatePrivateKey()` values from the harness. Nothing reaches a network.
 */

let w: World;
const pinned = DEPLOYMENTS['celo-sepolia'].enclaveRegistry;
beforeEach(() => {
  w = world();
  onboarded(w);
});
afterEach(() => {
  (DEPLOYMENTS['celo-sepolia'] as { enclaveRegistry: string | null }).enclaveRegistry = pinned;
});

describe('seller: adversary T15, network resolution (SPEC §2.6)', () => {
  // SPEC §2.6, `local` row: "the deployments entry and pins are copied from the network whose chain id
  // the RPC reports". T17 runs exactly this on an anvil fork of Sepolia (chain id 11142220) with no
  // registry override in its verify command.
  it('--network local on a Sepolia fork uses the pinned Sepolia registry without ATTESSA_REGISTRY', async () => {
    (DEPLOYMENTS['celo-sepolia'] as { enclaveRegistry: string | null }).enclaveRegistry = REGISTRY;
    delete w.env.ATTESSA_REGISTRY;
    expect(w.chain.chainId).toBe(11142220);
    const { doc } = attestation(w);
    w.files.set('att.bin', doc);
    const code = await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--network', 'local', '--rpc', 'http://127.0.0.1:8545');
    expect(w.err).toEqual([]);
    expect(code).toBe(0);
    const calldata = w.out.filter((l) => l.startsWith('  (calldata ')).map((l) => l.slice(12, -1) as Hex);
    const reg = decodeFunctionData({ abi: REGISTRY_ABI, data: calldata.at(-1)! });
    expect(reg.functionName).toBe('registerSigner');
    expect(reg.args[1]).toBe(originHash(ORIGIN));
    expect(w.out.some((l) => l.includes(`registerSigner; from ${w.operator} to ${REGISTRY}`))).toBe(true);
  });

  it('--network sepolia against an RPC on chain 42220 stops with the FLOWS wrong-network line and signs nothing', async () => {
    w.chain.chainId = 42220;
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    const { doc } = attestation(w);
    w.files.set('att.bin', doc);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--yes')).toBe(1);
    expect(w.err[0]).toBe('Your RPC is on chain 42220; this registry is on 11142220.');
    expect(w.err[1]).toBe('Set `--rpc` for 11142220.');
    expect(w.chain.sent).toHaveLength(0);
  });
});

describe('seller: adversary T15, send conditions (key, --dry-run, confirmation)', () => {
  it('signer register with the operator key, --yes and --dry-run signs nothing', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    const { doc } = attestation(w);
    w.files.set('att.bin', doc);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--yes', '--dry-run')).toBe(0);
    expect(w.out.at(-1)).toBe('  (dry run: nothing was sent)');
    expect(w.chain.sent).toHaveLength(0);
    expect(w.chain.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('signer register with the key but the prompt declined: exit 1, nothing signed', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    w.confirmAnswer = false;
    const { doc } = attestation(w);
    w.files.set('att.bin', doc);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin')).toBe(1);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('a stranger key with --yes is refused before anything is signed (not_operator)', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    const { doc } = attestation(w);
    w.files.set('att.bin', doc);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--yes')).toBe(1);
    expect(w.err[0]).toBe(`Not registered: ${w.owner} isn't the operator for ${ORIGIN}.`);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('endpoint add with the owner key, --yes and --dry-run signs nothing', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    const code = await w.cli('endpoint', 'add', '--agent', '412', '--origin', 'https://other.example', '--pay-to', '0x00000000000000000000000000000000000000fe', '--yes', '--dry-run');
    expect(code).toBe(0);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('an attestation 1801 s old is stale before any certificate tx is planned; 1800 s is not', async () => {
    const stale = attestation(w, { ageSec: 1801 });
    w.files.set('stale.bin', stale.doc);
    expect(await w.cli('signer', 'register', '--agent', String(AGENT), '--attestation', 'stale.bin')).toBe(1);
    expect(w.err[0]).toBe(
      "Not registered: the machine's report is 31 minutes old and Celo accepts 30. Run `attessa signer register --fresh` to get a new report from the same machine (no restart).",
    );
    const edge = attestation(w, { ageSec: 1800 });
    w.files.set('edge.bin', edge.doc);
    w.err.length = 0;
    expect(await w.cli('signer', 'register', '--agent', String(AGENT), '--attestation', 'edge.bin')).toBe(0);
  });
});
