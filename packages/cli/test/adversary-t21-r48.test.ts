import { originHash } from '@attessa/core';
import { keccak256, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, ORIGIN, onboarded, world, type World } from './harness.ts';

// Adversary T21 r48: the J4 `revoke release` prompt says the origin "refuses calls" when it does not.
//
// FLOWS J4 (FLOWS.md:583) names the consequence: "Its 1 live signer stops working within 60 s, and risk.example
// refuses calls until you approve and register another build." FLOWS.md:833 "Each prompt names the consequence".
// An origin can have several live signers on several approved releases (FLOWS J4 "Its {n} live signers"; SPEC §3.4
// checkSigner evaluates each signer against its own release). Here risk.example has a live signer S1 on release R1
// and a live signer S2 on release R2, both Approved. Revoking R1 stops S1, but risk.example keeps serving through S2
// (checkSigner(S2, originHash) == OK after the revoke), and the owner has already approved and registered another
// build. registry.ts releaseStatus puts every origin of R1's live signers into "refuses calls" without asking whether
// that origin has another live signer, so the confirm prompt states a false consequence.

const SRC = 'https://github.com/acme/risk/commit/a1b2c3d';

let w: World;
const s1 = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const s2 = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
let r2: Hex;

beforeEach(() => {
  w = world();
  onboarded(w);
  w.chain.approveRelease(AGENT, w.rid, SRC);
  // A second approved build of agent 412 (its own PCRs, so its own release id), serving the same origin.
  const pcrs: [Hex, Hex, Hex] = [`0x${'44'.repeat(48)}`, `0x${'55'.repeat(48)}`, `0x${'66'.repeat(48)}`];
  r2 = keccak256(`0x${pcrs.map((p) => p.slice(2)).join('')}`);
  w.chain.approveRelease(AGENT, r2, 'https://github.com/acme/risk/commit/b2c3d4e', pcrs);
  w.chain.addSigner(s1, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
  w.chain.addSigner(s2, { agentId: AGENT, releaseId: r2, originHash: originHash(ORIGIN), operator: w.operator });
  w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
});

describe('T21 adversary r48: revoke release on an origin that another approved build still serves', () => {
  it('status --agent shows both signers live before the revoke', async () => {
    expect(r2).not.toBe(w.rid);
    expect(w.chain.releases.get(`${AGENT}:${r2}`)).toBe(1);
    expect(await w.cli('status', '--agent', '412')).toBe(0);
    expect(w.out.filter((l) => l.startsWith('  Signer ') && l.includes(': Active,'))).toHaveLength(2);
  });

  it('the prompt does not say risk.example refuses calls while release R2 still serves it', async () => {
    w.confirmAnswer = false; // read the prompt, send nothing
    await w.cli('revoke', 'release', w.rid);
    const prompt = w.out.find((l) => l.startsWith('This stops buyers paying'))!;
    expect(prompt).toBeDefined();
    expect(prompt).toContain('Its 1 live signer stops working within 60 s');
    // After the revoke, S2 (release R2, Approved, endpoint Active, same operator) still passes checkSigner, so
    // risk.example keeps taking calls: "refuses calls until you approve and register another build" is false.
    expect(prompt).not.toMatch(/risk\.example refuses calls/);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('after the revoke lands, the CLI itself reports risk.example still served by a live signer', async () => {
    expect(await w.cli('revoke', 'release', w.rid, '--yes')).toBe(0);
    expect(w.chain.releases.get(`${AGENT}:${w.rid}`)).toBe(3);
    w.out.length = 0;
    expect(await w.cli('status', '--agent', '412')).toBe(0);
    const line = (s: Address) => w.out.find((l) => l.startsWith(`  Signer ${s.slice(0, 6)}`))!;
    expect(line(s1)).toMatch(/: Inert,/);
    expect(line(s2)).toMatch(/: Active,/);
    expect(w.out).toContain(`  Endpoint ${ORIGIN}: Active, pays 0x00000000000000000000000000000000000000fe, operator ${w.operator}`);
  });
});
