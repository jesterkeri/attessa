import { DEPLOYMENTS } from '@attessa/core';
import { TX_GAS_CAP } from '@attessa/sdk';
import { hexToBytes, parseTransaction, type TransactionSerialized } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { onboarded, world, type World } from './harness.ts';
import { IDENTITY } from './fake-chain.ts';

// Mainnet entry, adversary round 2: eth_call and eth_estimateGas run on the UNTAGGED calldata, the signed transaction
// carries the suffix. The suffix costs intrinsic gas (EIP-2028: 4 per zero byte, 16 per non-zero byte) that the
// estimate does not include. The 20% pad covers it everywhere except where the padded value is clamped to the cap.
// Live measurement (Celo mainnet, Forno, read-only, 2026-11-08): ERC-8004 register("https://example.org/agent.json")
// from 0x...dEaD estimates 0x1cbd1 untagged and 0x1cef1 with a 50-byte suffix, a delta of 800 gas.

// The longest suffix the validator accepts: a 32-character code.
const TAG = 'a'.repeat(32);
const worstSuffixGas = (() => {
  const bytes = hexToBytes(`0x${Buffer.from(TAG).toString('hex')}20${'00'}${'80218021'.repeat(4)}`);
  return BigInt(bytes.reduce((sum, b) => sum + (b === 0 ? 4 : 16), 0));
})();

(DEPLOYMENTS.celo as { identityRegistry: string }).identityRegistry = IDENTITY;

let w: World;
beforeEach(() => {
  w = world();
  onboarded(w);
  w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
  w.env.LOOPS_ATTRIBUTION_TAG = TAG;
  w.chain.chainId = 42220;
});

const REGISTER = ['agent', 'register', '--name', 'Acme risk check', '--uri', 'https://example.org/agent.json', '--yes', '--network', 'mainnet'];

/** The signed gas limit, or null when nothing was sent. */
async function signedGasFor(estimate: bigint): Promise<bigint | null> {
  w.chain.gasFor = (fn: string) => (fn === 'register' ? estimate : 100_000n);
  await w.cli(...REGISTER);
  return w.chain.sent.length === 0 ? null : (parseTransaction(w.chain.sent[0] as TransactionSerialized).gas ?? null);
}

describe('the gas limit of a tagged send covers the suffix', () => {
  it('the worst suffix costs 788 intrinsic gas', () => {
    expect(worstSuffixGas).toBe(788n);
  });

  it('control: a projected 14.5M estimate is clamped to the cap and still has room for the suffix', async () => {
    const gas = await signedGasFor(14_500_000n);
    expect(gas).toBe(TX_GAS_CAP - 1n);
    expect(gas! - 14_500_000n).toBeGreaterThanOrEqual(worstSuffixGas);
  });

  it('control: a small estimate is covered by the 20% pad', async () => {
    const gas = await signedGasFor(117_713n);
    expect(gas! - 117_713n).toBeGreaterThanOrEqual(worstSuffixGas);
  });

  it('an estimate within the suffix cost of the cap: refused, or signed with a limit that covers estimate + suffix', async () => {
    const estimate = TX_GAS_CAP - 1n - 200n; // 16,777,015: the untagged send fits in 16,777,215, the tagged one needs 788 more
    const gas = await signedGasFor(estimate);
    if (gas !== null) expect(gas).toBeGreaterThanOrEqual(estimate + worstSuffixGas);
  });
});
