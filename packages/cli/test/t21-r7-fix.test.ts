import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { originHash } from '@attessa/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { celoUp } from '../src/copy.ts';
import { hintPlan, parseAttestation } from '../src/attestation.ts';
import { RpcError } from '../src/rpc.ts';
import { AGENT, ORIGIN, attestation, onboarded, world, type World } from './harness.ts';

// T21 adversary r7 fixes beyond the adversary's own tests: a wallet without CELO for gas is the
// `insufficient_gas_funds` line (FLOWS §5 row 26), before signing when the balance read shows it, and when the node
// refuses the signed broadcast; the node's text is never printed, and a later step drops the closing "Nothing was …".

let w: World;
beforeEach(() => {
  w = world();
});

function failAt(method: string, err: () => Error, afterSends = 0): void {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[]) => {
    if (m === method && w.chain.sent.length >= afterSends) throw err();
    return orig(m, p);
  };
}

const NODE = 'insufficient funds for gas * price + value: balance 0, tx cost 52000000000000000, overshot 52000000000000000 NODE-REPLY-TEXT';
const REGISTER = ['agent', 'register', '--name', 'Acme risk check', '--uri', 'https://example.org/agent.json', '--yes'];

function registerSetup(): void {
  w.chain.owners.delete(AGENT);
  w.chain.nextAgentId = AGENT;
  w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
}

// register: estimate 2,000,000 padded to 2,400,000 gas, at 2 x 25 gwei + 1 gwei = 0.1224 CELO, shown rounded up.
const REGISTER_COST = 2_400_000n * 51_000_000_000n;

describe('agent register from a wallet without CELO', () => {
  it('a zero balance stops before signing: nothing signed, nothing broadcast', async () => {
    registerSetup();
    w.chain.balances.set(w.owner, 0n);
    expect(await w.cli(...REGISTER)).toBe(1);
    expect(w.chain.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false);
    expect(w.err).toEqual([
      `${w.owner} doesn't have enough CELO to pay the gas for register (up to 0.13 CELO). Nothing was signed.`,
      `Add CELO to ${w.owner} at faucet.celo.org/celo-sepolia, then run the command again.`,
    ]);
  });

  it('one wei short of the most the transaction can cost is refused; exactly enough is sent', async () => {
    registerSetup();
    w.chain.balances.set(w.owner, REGISTER_COST - 1n);
    expect(await w.cli(...REGISTER, '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'insufficient_gas_funds' });
    expect(w.chain.sent).toHaveLength(0);

    w = world();
    registerSetup();
    w.chain.balances.set(w.owner, REGISTER_COST);
    expect(await w.cli(...REGISTER)).toBe(0);
    expect(w.chain.sent).toHaveLength(1);
  });

  it('the node refuses the signed broadcast: "Nothing was sent.", without the node text', async () => {
    registerSetup();
    failAt('eth_sendRawTransaction', () => new RpcError(-32000, NODE, undefined));
    expect(await w.cli(...REGISTER)).toBe(1);
    expect(w.err).toEqual([
      `${w.owner} doesn't have enough CELO to pay the gas for register (up to 0.13 CELO). Nothing was sent.`,
      `Add CELO to ${w.owner} at faucet.celo.org/celo-sepolia, then run the command again.`,
    ]);
    expect(w.err.join('\n')).not.toMatch(/NODE-REPLY-TEXT|overshot/);
  });

  it('another -32000 refusal at broadcast is not read as missing CELO', async () => {
    registerSetup();
    failAt('eth_sendRawTransaction', () => new RpcError(-32000, 'nonce too low: insufficient funds later in text', undefined));
    expect(await w.cli(...REGISTER, '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'unexpected' });
  });

  it('the balance read failing is the rpc row, before anything is signed', async () => {
    registerSetup();
    failAt('eth_getBalance', () => new RpcError(-32005, 'rate limited', undefined));
    expect(await w.cli(...REGISTER, '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'rpc_unavailable' });
    expect(w.chain.calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false);
  });
});

describe('every write command, not only agent register', () => {
  it('revoke signer (owner): zero balance -> insufficient_gas_funds before signing', async () => {
    onboarded(w);
    const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
    w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    w.chain.balances.set(w.owner, 0n);
    expect(await w.cli('revoke', 'signer', signer, '--yes', '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'insufficient_gas_funds' });
    expect(w.chain.sent).toHaveLength(0);
  });

  it('signer register (operator): the 2nd step refused for CELO keeps the line without "Nothing was sent."', async () => {
    onboarded(w);
    const { doc } = attestation(w);
    for (const c of hintPlan(parseAttestation(doc)).certs.slice(0, 3)) w.chain.certs.set(c.certHash, { notAfter: w.chain.timestamp + 3600n, parent: c.parentCertHash });
    w.files.set('att.bin', doc);
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    failAt('eth_sendRawTransaction', () => new RpcError(-32000, NODE, undefined), 1);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--origin', ORIGIN, '--yes', '--json')).toBe(1);
    expect(w.chain.sent).toHaveLength(1);
    const out = JSON.parse(w.out.at(-1)!);
    expect(out).toMatchObject({ ok: false, error: 'insufficient_gas_funds', next: `Add CELO to ${w.operator} at faucet.celo.org/celo-sepolia, then run the command again.` });
    expect(out.message).toMatch(/^0x[0-9a-f]{40} doesn't have enough CELO to pay the gas for .+ \(up to [0-9.]+ CELO\)\.$/);
  });
});

describe('the next action depends on the chain: a faucet only on Celo Sepolia', () => {
  function revokeUnfunded(chainId: number): string[] {
    w.chain.chainId = chainId;
    onboarded(w);
    const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
    w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    w.chain.balances.set(w.owner, 0n);
    return ['revoke', 'signer', signer, '--yes'];
  }
  const plain = () => `Add CELO to ${w.owner}, then run the command again.`;
  const faucet = () => `Add CELO to ${w.owner} at faucet.celo.org/celo-sepolia, then run the command again.`;

  it('--network mainnet (42220): no faucet', async () => {
    const argv = revokeUnfunded(42220);
    w.env.LOOPS_ATTRIBUTION_TAG = 'celo_test1234'; // mainnet sends carry the Loops tag, so the tag is not what these tests are about
    expect(await w.cli(...argv, '--network', 'mainnet')).toBe(1);
    expect(w.err).toEqual([expect.stringMatching(/^0x[0-9a-f]{40} doesn't have enough CELO .* Nothing was signed\.$/), plain()]);
  });

  it('--network local on a fork of mainnet (42220): no faucet', async () => {
    const argv = revokeUnfunded(42220);
    w.env.LOOPS_ATTRIBUTION_TAG = 'celo_test1234'; // a verified 42220 send carries the Loops tag; the tag is not this test's subject
    expect(await w.cli(...argv, '--network', 'local', '--rpc', 'http://127.0.0.1:8545')).toBe(1);
    expect(w.err.at(-1)).toBe(plain());
  });

  it('--network sepolia (11142220): the faucet', async () => {
    const argv = revokeUnfunded(11142220);
    expect(await w.cli(...argv, '--network', 'sepolia')).toBe(1);
    expect(w.err.at(-1)).toBe(faucet());
  });

  it('--network local on a fork of Celo Sepolia (11142220): the faucet', async () => {
    const argv = revokeUnfunded(11142220);
    expect(await w.cli(...argv, '--network', 'local', '--rpc', 'http://127.0.0.1:8545')).toBe(1);
    expect(w.err.at(-1)).toBe(faucet());
  });

  it('--network local on another chain (31337): no faucet', async () => {
    const argv = revokeUnfunded(31337);
    expect(await w.cli(...argv, '--network', 'local', '--rpc', 'http://127.0.0.1:8545')).toBe(1);
    expect(w.err.at(-1)).toBe(plain());
  });
});

describe('celoUp', () => {
  it('rounds up, to hundredths below 1 CELO and to whole CELO from 1', () => {
    expect(celoUp(0n)).toBe('0.00');
    expect(celoUp(1n)).toBe('0.01');
    expect(celoUp(122_400_000_000_000_000n)).toBe('0.13');
    expect(celoUp(990_000_000_000_000_000n)).toBe('0.99');
    expect(celoUp(990_000_000_000_000_001n)).toBe('1');
    expect(celoUp(12_000_000_000_000_000_001n)).toBe('13');
  });
});
