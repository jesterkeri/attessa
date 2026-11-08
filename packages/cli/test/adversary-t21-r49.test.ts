import { originHash } from '@attessa/core';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, ORIGIN, onboarded, world, type World } from './harness.ts';

// Adversary T21 r49: the J4 owner reads and prompts, against the CLI's fake chain.
//
// 1. `attessa status --agent <id>` for an agent id the identity registry doesn't know (a typo, or the wrong
//    `--network`) prints the heading "Agent {id}" and FLOWS §8's empty state "No releases yet. Approve one with
//    `attessa release approve`.", exit 0. The agent doesn't exist, so the state is wrong, and the one next action
//    can't work: `attessa release approve --agent 999` ends `unknown_agent` ("Agent 999 doesn't exist on this
//    network's identity registry."), the CLI's own row for this case (packages/cli/src/commands/owner.ts ownerOf).
//    FLOWS §8 places, attessa status: "lists releases, endpoints, signers with states"; FLOWS.md:832 "Every error
//    row has one next action" (one that works).
// 2. `attessa revoke signer <addr>` on a signer that already stopped (expired: checkSigner SIGNER_EXPIRED, SPEC §3.4;
//    or Inert because its release was revoked: RELEASE_NOT_APPROVED) still prompts "This stops signer … within
//    60 s", while `status --agent` lists that same signer as Expired / Inert and `revoke release` says "It has no
//    live signers." FLOWS.md:833 "Each prompt names the consequence"; the r46 fix applied that rule to
//    `revoke release` but not to `revoke signer`.

const SRC = 'https://github.com/acme/risk/commit/a1b2c3d';

let w: World;
const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;

const step = async (argv: string[]) => {
  w.out.length = 0;
  w.err.length = 0;
  const code = await w.cli(...argv);
  return { code, out: [...w.out], err: [...w.err] };
};

describe('T21 adversary r49: status --agent for an agent the identity registry does not have', () => {
  beforeEach(() => {
    w = world();
  });

  it('agent 999 has no owner on this network: release approve says so', async () => {
    w.files.set('/srv/risk/build/measurements.json', Buffer.from(JSON.stringify({ Measurements: { PCR0: '11'.repeat(48), PCR1: '22'.repeat(48), PCR2: '33'.repeat(48) } })));
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    const r = await step(['release', 'approve', '--agent', '999', '--from-build', '/srv/risk/build/measurements.json', '--source', SRC]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toBe("Agent 999 doesn't exist on this network's identity registry.");
  });

  it('does not report agent 999 as an agent with no releases, nor send the owner to release approve', async () => {
    const r = await step(['status', '--agent', '999']);
    // The agent doesn't exist; "No releases yet. Approve one with `attessa release approve`." is a next action that
    // can only end unknown_agent (previous test).
    expect(r.out).not.toContain('No releases yet. Approve one with `attessa release approve`.');
    expect(r.code).toBe(1);
    const j = JSON.parse((await step(['status', '--agent', '999', '--json'])).out.at(-1)!);
    expect(j).toMatchObject({ ok: false, error: 'unknown_agent' });
  });
});

describe('T21 adversary r49: revoke signer on a signer that already stopped', () => {
  beforeEach(() => {
    w = world();
    onboarded(w);
    w.chain.approveRelease(AGENT, w.rid, SRC);
    w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    w.confirmAnswer = false; // read the prompt, send nothing
  });

  it('an expired signer: the prompt does not say revoking stops it within 60 s', async () => {
    w.chain.timestamp += 604800n; // now == expiresAt: checkSigner SIGNER_EXPIRED (SPEC §3.4 "now >= expiresAt")
    const st = await step(['status', '--agent', '412']);
    expect(st.out.find((l) => l.startsWith('  Signer '))).toMatch(/: Expired,/);
    const rel = await step(['revoke', 'release', w.rid]);
    expect(rel.out[0]).toContain('It has no live signers.');

    const r = await step(['revoke', 'signer', signer]);
    const prompt = r.out.find((l) => l.startsWith('This stops signer') || l.includes('[revoke/cancel]'))!;
    expect(prompt).toBeDefined();
    expect(prompt).not.toMatch(/^This stops signer .* within 60 s\./);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('a signer left Inert by its revoked release: the prompt does not say revoking stops it within 60 s', async () => {
    w.chain.releases.set(`${AGENT}:${w.rid}`, 3);
    const st = await step(['status', '--agent', '412']);
    expect(st.out.find((l) => l.startsWith('  Signer '))).toMatch(/: Inert,/);

    const r = await step(['revoke', 'signer', signer]);
    const prompt = r.out.find((l) => l.startsWith('This stops signer') || l.includes('[revoke/cancel]'))!;
    expect(prompt).toBeDefined();
    expect(prompt).not.toMatch(/^This stops signer .* within 60 s\./);
    expect(w.chain.sent).toHaveLength(0);
  });
});
