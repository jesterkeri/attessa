import { describe, expect, it } from 'vitest';
import { AGENT, onboarded, world } from './harness.ts';
import { refuseSecretUrl } from '../src/copy.ts';

// Codex T21 review r3. M1: a dry run printed the calldata of `release approve --source` / `agent register --uri`,
// which holds the URL as given; the CLI now refuses a URL with userinfo, query or fragment before anything is
// encoded (it would be published on Celo for good). M2: `status --agent` read sourceRef and endpoint origins from
// chain and printed and returned them raw; they are cleaned for text and --json alike.

const SECRETS = ['USERNAMEX', 'CREDENTIAL', 'QUERYKEY', 'FRAGKEY'];
const leaks = (s: string) => SECRETS.filter((x) => s.includes(x));

describe('URLs the CLI would publish are refused when they carry secrets (Codex T21 r3 M1)', () => {
  it('userinfo, query and fragment are refused; scheme, host and path pass', () => {
    for (const bad of [
      'https://USERNAMEX:CREDENTIAL@github.com/acme/risk/commit/abcdef0',
      'https://github.com/acme/risk/commit/abcdef0?t=QUERYKEY',
      'https://github.com/acme/risk/commit/abcdef0#FRAGKEY',
      'git+ssh://USERNAMEX@[2001:db8::1]/acme/risk',
      'not-a-url //USERNAMEX:CREDENTIAL@host/x',
    ]) expect(() => refuseSecretUrl(bad, '--source'), bad).toThrow(/published on Celo for good/);
    for (const ok of ['https://github.com/acme/risk/commit/abcdef0', 'git@github.com:acme/risk.git', 'https://risk.example/agent.json', undefined])
      expect(() => refuseSecretUrl(ok, '--source'), String(ok)).not.toThrow();
  });

  for (const [cmd, flag] of [[['release', 'approve', '--agent', '412', '--from-build', 'measurements.json'], '--source'], [['agent', 'register', '--name', 'x', '--description', 'y'], '--uri']] as const) {
    it(`${cmd.slice(0, 2).join(' ')} ${flag} with a credential: refused before any calldata, text and --json`, async () => {
      for (const json of [false, true]) {
        const w = world();
        onboarded(w);
        const url = 'https://USERNAMEX:CREDENTIAL@git.example/acme/risk?t=QUERYKEY#FRAGKEY';
        const code = await w.cli(...cmd, flag, url, '--dry-run', ...(json ? ['--json'] : []));
        const all = [...w.out, ...w.err].join('\n');
        expect(code).toBe(1);
        expect(leaks(all)).toEqual([]);
        expect(all).not.toMatch(/0x[0-9a-f]{200,}/); // no calldata
        if (json) expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'secret_in_url', next: `Pass ${flag} with only its scheme, host and path.` });
        else expect(w.err.at(-1)).toBe(`Pass ${flag} with only its scheme, host and path.`);
      }
    });
  }
});

describe('status --agent cleans URLs read from chain (Codex T21 r3 M2)', () => {
  it('a sourceRef and an endpoint origin with credentials are cleaned in text and --json', async () => {
    const w = world();
    onboarded(w);
    w.chain.approveRelease(AGENT, w.rid, 'https://USERNAMEX:CREDENTIAL@git.example/acme/risk?t=QUERYKEY#FRAGKEY');
    w.chain.addEndpoint(AGENT, 'https://USERNAMEX:CREDENTIAL@evil.example:8443/x?k=QUERYKEY#FRAGKEY', w.operator, w.operator);
    expect(await w.cli('status', '--agent', '412')).toBe(0);
    const text = w.out.join('\n');
    expect(leaks(text)).toEqual([]);
    expect(text).toContain('https://git.example/acme/risk');
    expect(text).toContain('https://evil.example:8443');
    w.out.length = 0;
    expect(await w.cli('status', '--agent', '412', '--json')).toBe(0);
    const j = w.out.at(-1)!;
    expect(leaks(j)).toEqual([]);
    const o = JSON.parse(j);
    expect(o.releases.map((r: { sourceRef: string }) => r.sourceRef)).toContain('https://git.example/acme/risk');
    expect(o.endpoints.map((e: { origin: string }) => e.origin)).toContain('https://evil.example:8443');
  });
});
