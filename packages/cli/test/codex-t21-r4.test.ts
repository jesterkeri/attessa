import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { AGENT, onboarded, world } from './harness.ts';
import { refuseSecretUrl } from '../src/copy.ts';

// Codex T21 review r4. M1: `--source`/`--uri` text that is not a URL but has `?` or `#` reached printed calldata.
// M2: the EndpointAdded origin readers behind `revoke signer`, `revoke release` and the signer flows returned the
// raw on-chain string; they now return scheme://host[:port] only.

const MARKS = ['USERMARK', 'SECRETMARK', 'QUERYMARK', 'FRAGMARK'];
const leaks = (s: string) => MARKS.filter((m) => s.includes(m));

describe('free text with ? or # is refused before it is published (Codex T21 r4 M1)', () => {
  it('refuseSecretUrl refuses non-URL text with a query or fragment mark, keeps plain text', () => {
    for (const bad of ['not-a-url?QUERYMARK', 'not-a-url#FRAGMARK', '  acme/risk ?QUERYMARK  '])
      expect(() => refuseSecretUrl(bad, '--source'), bad).toThrow(/published on Celo for good/);
    expect(() => refuseSecretUrl('acme/risk at a1b2c3d', '--source')).not.toThrow();
  });

  for (const [cmd, flag] of [[['release', 'approve', '--agent', '412', '--from-build', 'measurements.json'], '--source'], [['agent', 'register', '--name', 'x', '--description', 'y'], '--uri']] as const) {
    it(`${cmd.slice(0, 2).join(' ')} ${flag} 'not-a-url?QUERYMARK' --dry-run --json: refused, no calldata`, async () => {
      const w = world();
      onboarded(w);
      expect(await w.cli(...cmd, flag, 'not-a-url?QUERYMARK#FRAGMARK', '--dry-run', '--json')).toBe(1);
      const all = [...w.out, ...w.err].join('\n');
      expect(leaks(all)).toEqual([]);
      expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'secret_in_url' });
    });
  }
});

describe('origins read from EndpointAdded are shown as scheme://host[:port] (Codex T21 r4 M2)', () => {
  const EVIL = 'https://USERMARK:SECRETMARK@evil.example:8443/p?QUERYMARK#FRAGMARK';
  function rig() {
    const w = world();
    onboarded(w);
    w.chain.addEndpoint(AGENT, EVIL, w.operator, w.operator);
    const oh = [...w.chain.endpoints.keys()].at(-1) as Hex;
    const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
    w.chain.approveRelease(AGENT, w.rid, 'https://github.com/acme/risk/commit/a1b2c3d');
    w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: oh, operator: w.operator });
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    return { w, signer };
  }

  it('revoke signer: the prompt and its outcome never show the raw origin', async () => {
    const { w, signer } = rig();
    await w.cli('revoke', 'signer', signer);
    const all = [...w.out, ...w.err].join('\n');
    expect(leaks(all)).toEqual([]);
    expect(all).toContain('evil.example');
  });

  it('revoke release: the prompt naming the endpoints that stop never shows the raw origin', async () => {
    const { w } = rig();
    await w.cli('revoke', 'release', w.rid);
    const all = [...w.out, ...w.err].join('\n');
    expect(leaks(all)).toEqual([]);
  });
});
