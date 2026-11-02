import { DEPLOYMENTS } from '@attessa/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY } from './fake-chain.ts';
import { attestation, onboarded, world, type World } from './harness.ts';

/**
 * Adversary pass on T15, round 2 (CLI side): registry resolution per SPEC §2.6. Every chain is the
 * in-process FakeChain, which answers only calls to REGISTRY; keys are throwaway harness keys.
 */

type Pin = { enclaveRegistry: string | null };
const DECOY = '0x00000000000000000000000000000000000000d0';
const saved = { sepolia: DEPLOYMENTS['celo-sepolia'].enclaveRegistry, celo: DEPLOYMENTS.celo.enclaveRegistry };
function pin(net: 'celo-sepolia' | 'celo', a: string | null): void {
  (DEPLOYMENTS[net] as Pin).enclaveRegistry = a;
}

let w: World;
beforeEach(() => {
  w = world();
  onboarded(w);
});
afterEach(() => {
  pin('celo-sepolia', saved.sepolia);
  pin('celo', saved.celo);
});

async function register(...extra: string[]): Promise<number> {
  const { doc } = attestation(w);
  w.files.set('att.bin', doc);
  return w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', ...extra);
}

const planned = (to: string) => w.out.some((l) => l.includes(`registerSigner; from ${w.operator} to ${to}`));
const LOCAL = ['--network', 'local', '--rpc', 'http://127.0.0.1:8545'];

describe('seller: adversary T15 r2, local chain with no deployments entry', () => {
  it('chain 31337 without ATTESSA_REGISTRY stops with no_registry and calls nothing beyond eth_chainId', async () => {
    w.chain.chainId = 31337;
    delete w.env.ATTESSA_REGISTRY;
    expect(await register(...LOCAL)).toBe(1);
    expect(w.err[0]).toBe('No EnclaveRegistry address is known for local.');
    expect(w.chain.calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });

  it('chain 31337 with ATTESSA_REGISTRY uses the override', async () => {
    w.chain.chainId = 31337;
    w.env.ATTESSA_REGISTRY = REGISTRY.toUpperCase().replace('0X', '0x');
    expect(await register(...LOCAL)).toBe(0);
    expect(planned(REGISTRY)).toBe(true);
  });

  it('chain 31337 with a malformed ATTESSA_REGISTRY is a usage error', async () => {
    w.chain.chainId = 31337;
    w.env.ATTESSA_REGISTRY = '0x1234';
    expect(await register(...LOCAL)).toBe(1);
    expect(w.err[0]).toBe('ATTESSA_REGISTRY must be an address.');
  });
});

describe('seller: adversary T15 r2, pinned registry wins over ATTESSA_REGISTRY', () => {
  it('local on a Sepolia fork: the Sepolia pin, not the env decoy', async () => {
    pin('celo-sepolia', REGISTRY);
    w.env.ATTESSA_REGISTRY = DECOY;
    expect(await register(...LOCAL)).toBe(0);
    expect(planned(REGISTRY)).toBe(true);
    expect(w.out.some((l) => l.includes(DECOY))).toBe(false);
  });

  it('local on a mainnet fork (42220): the mainnet pin, not Sepolia pin nor env', async () => {
    w.chain.chainId = 42220;
    pin('celo', REGISTRY);
    pin('celo-sepolia', DECOY);
    w.env.ATTESSA_REGISTRY = DECOY;
    expect(await register(...LOCAL)).toBe(0);
    expect(planned(REGISTRY)).toBe(true);
  });

  it('local on 42220 with Sepolia pinned and mainnet not: the env fills in, the Sepolia pin is not borrowed', async () => {
    w.chain.chainId = 42220;
    pin('celo-sepolia', DECOY);
    w.env.ATTESSA_REGISTRY = REGISTRY;
    expect(await register(...LOCAL)).toBe(0);
    expect(planned(REGISTRY)).toBe(true);
  });

  it('--network sepolia: the pin wins and a malformed env is ignored', async () => {
    pin('celo-sepolia', REGISTRY);
    w.env.ATTESSA_REGISTRY = 'not-an-address';
    expect(await register()).toBe(0);
    expect(planned(REGISTRY)).toBe(true);
  });

  it('--network mainnet against a Sepolia RPC is refused even with ATTESSA_REGISTRY set', async () => {
    w.env.ATTESSA_REGISTRY = REGISTRY;
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    expect(await register('--network', 'mainnet', '--rpc', 'http://127.0.0.1:8545', '--yes')).toBe(1);
    expect(w.err[0]).toBe('Your RPC is on chain 11142220; this registry is on 42220.');
    expect(w.chain.sent).toHaveLength(0);
  });
});
