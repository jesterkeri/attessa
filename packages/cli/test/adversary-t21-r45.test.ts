import { originHash } from '@attessa/core';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, ORIGIN, onboarded, world, type World } from './harness.ts';

// Adversary T21 r45: the owner commands from registry.ts, against the CLI's fake chain.
//
// 1. `attessa status --agent` derives a signer's state from the signer record alone (plus expiry), so after
//    `attessa revoke release` (or `endpoint retire`) the signer whose build or endpoint is gone is still listed
//    "Active", and `--json` `.signer` (what T36 reads) picks it as the active one. FLOWS §7 signer statechart:
//    "Active --> Inert: release Revoked or Deprecated-for-new-calls / endpoint Retired / ..." and "Checks evaluate
//    signer AND release AND endpoint"; FLOWS §8 places, attessa status: "lists releases, endpoints, signers with states".
// 2. Owner refusals added in registry.ts end with no next action: a second `revoke release` (invalid_transition) and a
//    second `revoke signer` (signer_not_active). FLOWS.md:832 "Every error row has one next action".

const SRC = 'https://github.com/acme/risk/commit/a1b2c3d';

let w: World;
const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
beforeEach(() => {
  w = world();
  onboarded(w);
  w.chain.approveRelease(AGENT, w.rid, SRC);
  w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
});

const step = async (argv: string[]) => {
  w.out.length = 0;
  w.err.length = 0;
  const code = await w.cli(...argv);
  return { code, out: [...w.out], err: [...w.err] };
};

describe('status --agent after the owner revoked the release', () => {
  it('does not list the signer of the revoked build as Active', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expect((await step(['revoke', 'release', w.rid, '--yes'])).code).toBe(0);
    expect(w.chain.releases.get(`${AGENT}:${w.rid}`)).toBe(3);
    delete w.env.ATTESSA_PRIVATE_KEY;

    const human = await step(['status', '--agent', '412']);
    expect(human.code).toBe(0);
    expect(human.out).toContain(`  Release ${w.rid.slice(0, 6)}…${w.rid.slice(-2)}: Revoked, owner says acme/risk @ a1b2c3d`);
    const line = human.out.find((l) => l.startsWith(`  Signer ${signer.slice(0, 6)}`))!;
    // The revoke prompt said "Its 1 live signer stops working within 60 s"; status must not say it is still live.
    expect(line).not.toMatch(/: Active,/);

    const j = JSON.parse((await step(['status', '--agent', '412', '--json'])).out.at(-1)!);
    expect(j.signers[0].status).not.toBe('Active');
  });

  it('does not list the signer of a retired endpoint as Active', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expect((await step(['endpoint', 'retire', '--origin', ORIGIN, '--yes'])).code).toBe(0);
    delete w.env.ATTESSA_PRIVATE_KEY;
    const j = JSON.parse((await step(['status', '--agent', '412', '--json'])).out.at(-1)!);
    expect(j.endpoints[0].status).toBe('Retired');
    expect(j.signers[0].status).not.toBe('Active');
  });
});

describe('owner refusals carry one next action (FLOWS.md:832)', () => {
  it('revoke release on a release already revoked', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expect((await step(['revoke', 'release', w.rid, '--yes'])).code).toBe(0);
    const again = await step(['revoke', 'release', w.rid, '--yes']);
    expect(again.code).toBe(1);
    expect(again.err[0]).toBe(`Release ${w.rid.slice(0, 6)}…${w.rid.slice(-2)} is revoked; that change isn't allowed.`);
    expect(again.err).toHaveLength(2);
    const j = JSON.parse((await step(['revoke', 'release', w.rid, '--yes', '--json'])).out.at(-1)!);
    expect(j).toMatchObject({ ok: false, error: 'invalid_transition' });
    expect(typeof j.next).toBe('string');
  });

  it('revoke signer on a signer already revoked', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expect((await step(['revoke', 'signer', signer, '--yes'])).code).toBe(0);
    const again = await step(['revoke', 'signer', signer, '--yes']);
    expect(again.code).toBe(1);
    expect(again.err[0]).toBe(`Signer ${signer.slice(0, 6)}…${signer.slice(-2)} is already revoked.`);
    expect(again.err).toHaveLength(2);
  });
});
