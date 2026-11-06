import { originHash } from '@attessa/core';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, ORIGIN, onboarded, world, type World } from './harness.ts';

// Adversary T21 r46: the J4 `revoke release` prompt still counts Inert signers as live.
//
// FLOWS §7 signer statechart (FLOWS.md:698): "Active --> Inert: release Revoked or Deprecated-for-new-calls / endpoint
// Retired / endpoint operator changed", and FLOWS.md:706 "Checks evaluate signer AND release AND endpoint". SPEC §3.4
// checkSigner: AGENT_MISMATCH (`e.agentId != s.agentId`) and RELEASE_NOT_APPROVED both fail the signer. The r45 fix
// makes `status --agent` show such signers as Inert, but the prompt's live count (registry.ts releaseStatus) checks
// only signer status, expiry, endpoint status and operator:
// 1. Revoking a release that is already Deprecated: its signer is Inert (status says so), yet the prompt says
//    "Its 1 live signer stops working within 60 s, and risk.example refuses calls until ...".
// 2. The origin retired by agent 412 and re-added by agent 413 with the same operator: 412's old signer there is
//    AGENT_MISMATCH (Inert in status), yet the prompt counts it live and says 413's risk.example "refuses calls".

const SRC = 'https://github.com/acme/risk/commit/a1b2c3d';
const OTHER = 413n;

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

const signerLine = (out: string[]) => out.find((l) => l.startsWith(`  Signer ${signer.slice(0, 6)}`))!;

describe('revoke release prompt counts only signers that checkSigner would pass', () => {
  it('a Deprecated release has no live signers', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expect((await step(['release', 'deprecate', w.rid, '--yes'])).code).toBe(0);
    expect(w.chain.releases.get(`${AGENT}:${w.rid}`)).toBe(2);

    // status agrees with FLOWS §7: the signer of a deprecated build is Inert.
    expect(signerLine((await step(['status', '--agent', '412'])).out)).toMatch(/: Inert,/);

    w.confirmAnswer = false; // read the prompt, send nothing
    const r = await step(['revoke', 'release', w.rid]);
    const prompt = r.out.find((l) => l.startsWith('This stops buyers paying'))!;
    expect(prompt).toBeDefined();
    expect(prompt).toContain('It has no live signers.');
    expect(prompt).not.toMatch(/live signer stops working/);
  });

  it('a signer whose origin now belongs to another agent is not live', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expect((await step(['endpoint', 'retire', '--origin', ORIGIN, '--yes'])).code).toBe(0);
    // Another agent takes the freed origin (SPEC §3.4 addEndpoint: "overwrites a retired record (including agentId)"),
    // run by the same hosting operator.
    w.chain.addEndpoint(OTHER, ORIGIN, '0x00000000000000000000000000000000000000fd', w.operator);
    expect(w.chain.endpoints.get(originHash(ORIGIN))).toMatchObject({ agentId: OTHER, status: 1 });

    expect(signerLine((await step(['status', '--agent', '412'])).out)).toMatch(/: Inert,/);

    w.confirmAnswer = false;
    const r = await step(['revoke', 'release', w.rid]);
    const prompt = r.out.find((l) => l.startsWith('This stops buyers paying'))!;
    expect(prompt).toBeDefined();
    // Agent 413's risk.example does not start refusing calls when agent 412 revokes its build.
    expect(prompt).toContain('It has no live signers.');
    expect(prompt).not.toMatch(/risk\.example refuses calls/);
  });
});
