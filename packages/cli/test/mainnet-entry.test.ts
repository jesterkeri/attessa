import { DEPLOYMENTS } from '@attessa/core';
import { encodeFunctionResult, type Address, type Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY_ABI } from '../src/abi.ts';
import { AGENT, ORIGIN, attestation, world, type World } from './harness.ts';
import { IDENTITY, REGISTRY } from './fake-chain.ts';

// Change 1: `attessa agent register --network mainnet` before our EnclaveRegistry exists. The pinned ERC-8004
// identity registry is used when no EnclaveRegistry is deployed; every other command still needs the registry.

const MAIN_IDENTITY = DEPLOYMENTS.celo.identityRegistry.toLowerCase() as Address;
const ADDR = '0x00000000000000000000000000000000000000fe';
const URI = 'https://example.org/agent.json';
const REGISTER = ['agent', 'register', '--name', 'Acme risk check', '--uri', URI];

let w: World;

/** The fake chain stands in for mainnet; `alias` maps a real pinned address onto the fake identity registry. */
function asMainnet(alias: Record<string, Address>): void {
  w.chain.chainId = 42220;
  delete w.env.ATTESSA_REGISTRY;
  const exec = w.chain.exec.bind(w.chain);
  w.chain.exec = (from, to, data, write) => exec(from, alias[to] ?? to, data, write);
}

beforeEach(() => {
  w = world();
});

describe('agent register with no EnclaveRegistry deployed', () => {
  it('--dry-run with no key and no ATTESSA_REGISTRY plans against the pinned identity registry', async () => {
    asMainnet({ [MAIN_IDENTITY]: IDENTITY });
    expect(await w.cli(...REGISTER, '--network', 'mainnet', '--dry-run')).toBe(0);
    const out = w.out.join('\n');
    expect(out).toContain(`to ${MAIN_IDENTITY}`);
    expect(out).toContain('eth_call ok');
    expect(w.chain.sent).toHaveLength(0);
    // The EnclaveRegistry is never asked: there is none.
    expect(w.chain.calls.filter((c) => c.method === 'eth_call' && String((c.params[0] as { to: string }).to).toLowerCase() === REGISTRY)).toHaveLength(0);
  });

  it('any other registry command still refuses with no_registry', async () => {
    asMainnet({ [MAIN_IDENTITY]: IDENTITY });
    const pcr = (n: string) => n.repeat(48);
    w.files.set('build/measurements.json', Buffer.from(JSON.stringify({ Measurements: { PCR0: pcr('11'), PCR1: pcr('22'), PCR2: pcr('33') } })));
    w.files.set('att.bin', attestation(w).doc);
    const sig = `0x${'11'.repeat(65)}`;
    const cmds: string[][] = [
      ['agent', 'transfer', '--agent', '412', '--to', ADDR],
      ['agent', 'wallet-sig', '--agent', '412', '--owner', ADDR],
      ['agent', 'set-wallet', '--agent', '412', '--wallet', ADDR, '--sig', sig, '--deadline', '1800000000'],
      ['selflink', '--agent', '412', '--self-agent', '1'],
      ['release', 'approve', '--agent', '412', '--from-build', 'build/measurements.json', '--source', 'https://github.com/acme/risk/commit/a1b2c3d'],
      ['release', 'deprecate', w.rid, '--agent', '412'],
      ['revoke', 'signer', ADDR],
      ['endpoint', 'add', '--agent', '412', '--origin', ORIGIN, '--pay-to', ADDR, '--operator', ADDR],
      ['endpoint', 'retire', '--origin', ORIGIN],
      ['status', '--agent', '412'],
      ['signer', 'register', '--agent', '412', '--attestation', 'att.bin'],
      ['signer', 'renew', '--attestation', 'att.bin'],
    ];
    for (const argv of cmds) {
      w.out.length = 0;
      w.err.length = 0;
      expect(await w.cli(...argv, '--network', 'mainnet', '--dry-run', '--json'), argv.join(' ')).toBe(1);
      expect(JSON.parse(w.out.at(-1)!), argv.join(' ')).toMatchObject({ ok: false, error: 'no_registry' });
    }
    expect(w.chain.sent).toHaveLength(0);
  });

  it('a deployed registry keeps authority: its identityRegistry() answer is used, not the pin', async () => {
    const OTHER = '0x00000000000000000000000000000000000000aa' as Address;
    // Sepolia has a (fake) deployed registry in the harness; it names OTHER as its identity registry.
    const exec = w.chain.exec.bind(w.chain);
    w.chain.exec = (from, to, data, write) => {
      if (to === REGISTRY && data.startsWith('0x') && data.slice(0, 10) === '0x' + IDENTITY_SELECTOR) {
        return { out: encodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'identityRegistry', result: OTHER }) as Hex, gas: 30_000n };
      }
      return exec(from, to === OTHER ? IDENTITY : to, data, write);
    };
    expect(await w.cli(...REGISTER, '--network', 'sepolia', '--dry-run')).toBe(0);
    const out = w.out.join('\n');
    expect(out).toContain(`to ${OTHER}`);
    expect(out).not.toContain(`to ${DEPLOYMENTS['celo-sepolia'].identityRegistry.toLowerCase()}`);
  });

  it('ATTESSA_REGISTRY set before deploy: that registry is still asked for its identityRegistry()', async () => {
    asMainnet({});
    w.env.ATTESSA_REGISTRY = REGISTRY;
    // mainnet has no pin for the fake IDENTITY, so the registry's answer (IDENTITY) is what the plan must name.
    expect(await w.cli(...REGISTER, '--network', 'mainnet', '--dry-run')).toBe(0);
    expect(w.out.join('\n')).toContain(`to ${IDENTITY}`);
  });
});

import { toFunctionSelector } from 'viem';
const IDENTITY_SELECTOR = toFunctionSelector('identityRegistry()').slice(2);
void AGENT;
