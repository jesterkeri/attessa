import { DEPLOYMENTS } from '@attessa/core';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness.ts';
import { IDENTITY } from './fake-chain.ts';

// Mainnet entry, adversary round 3. A stray ATTESSA_REGISTRY (left over from a Sepolia session, so an address with no
// code on Celo mainnet) must not turn `agent register` on mainnet into the generic "Unexpected error" crash. The task
// spec says register works on mainnet before any Attessa registry exists. Acceptable outcomes: it plans/sends against
// the pinned identity registry, or it refuses with a row that names ATTESSA_REGISTRY. A raw AbiDecodingZeroDataError
// is neither. A real node answers an eth_call to an address with no code with empty return data ("0x").

const MAIN_IDENTITY = DEPLOYMENTS.celo.identityRegistry.toLowerCase() as Address;
const SEPOLIA_REGISTRY = '0x42bf5cb440c3c321cb42b0f4c81c3c7435cb92ff';
const REGISTER = ['agent', 'register', '--name', 'Acme risk check', '--uri', 'https://example.org/agent.json', '--network', 'mainnet', '--dry-run'];

let w: World;
beforeEach(() => {
  w = world();
  w.chain.chainId = 42220;
  const exec = w.chain.exec.bind(w.chain);
  w.chain.exec = (from, to, data, write) => {
    if (to === SEPOLIA_REGISTRY) return { out: '0x', gas: 0n };
    return exec(from, to === MAIN_IDENTITY ? IDENTITY : to, data, write);
  };
  w.env.ATTESSA_REGISTRY = SEPOLIA_REGISTRY;
});

describe('agent register on mainnet with an ATTESSA_REGISTRY that has no code there', () => {
  it('plans against the pinned identity registry, or refuses with a row that names ATTESSA_REGISTRY', async () => {
    const code = await w.cli(...REGISTER);
    const text = [...w.out, ...w.err].join('\n');
    expect(text, `exit ${code}`).not.toMatch(/Unexpected error|AbiDecoding/);
    const worked = code === 0 && text.includes(`to ${MAIN_IDENTITY}`);
    const explained = code !== 0 && text.includes('ATTESSA_REGISTRY');
    expect(worked || explained, `exit ${code}\n${text}`).toBe(true);
  });
});
