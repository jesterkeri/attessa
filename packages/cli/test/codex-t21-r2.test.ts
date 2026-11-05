import { describe, expect, it } from 'vitest';
import { repoLabel } from '../src/commands/enclave.ts';
import { fetchAttestation } from '../src/commands/signer.ts';
import { ERR, lastResortLines, sourceLabel, withoutCredentials } from '../src/copy.ts';

// Codex T21 review r2. M1: no user-visible URL (seller-host, --source, git remote) prints userinfo, a key in the
// path or query, or a fragment. M2: release_exists prints its next action in text mode. m1: the binary's last-resort
// line carries the fallback next action.

const SECRETS = ['operator', 'CREDENTIAL', 'PATHKEY', 'QUERYKEY', 'FRAGKEY'];
const clean = (s: string) => SECRETS.filter((x) => s.includes(x));

describe('seller-host URL in error lines (Codex T21 r2 M1)', () => {
  const url = 'https://operator:CREDENTIAL@seller.example:8443/PATHKEY?k=QUERYKEY#FRAGKEY';
  const deps = (fetch: () => Promise<Response>) => ({ fetch }) as never;

  it('unreachable, no enclave and HTTP error lines show scheme://host:port only', async () => {
    const cases = [
      () => fetchAttestation(deps(async () => { throw new Error('down'); }), url),
      () => fetchAttestation(deps(async () => new Response(JSON.stringify({ error: 'enclave_unavailable' }), { status: 503 })), url),
      () => fetchAttestation(deps(async () => new Response('nope', { status: 500 })), url),
    ];
    for (const c of cases) {
      const e = (await c().catch((x: unknown) => x)) as Error & { next: string };
      expect(e.message).toContain('https://seller.example:8443');
      expect(clean(e.message + e.next)).toEqual([]);
    }
  });

  it('a seller-host value that is not a URL is never echoed', async () => {
    const e = (await fetchAttestation(({ fetch: async () => { throw new Error('x'); } }) as never, 'operator:CREDENTIAL').catch((x: unknown) => x)) as Error;
    expect(e.message).toBe("Can't reach the seller-host at the --seller-host URL.");
  });
});

describe('--source and git remote labels (Codex T21 r2 M1)', () => {
  it('a GitHub commit ref with userinfo, and other URLs, lose userinfo, query and fragment', () => {
    expect(clean(sourceLabel('https://user:CREDENTIAL@github.com/acme/risk/commit/abcdef0'))).toEqual([]);
    expect(sourceLabel('https://operator:CREDENTIAL@git.example/acme/risk?t=QUERYKEY#FRAGKEY')).toBe('https://git.example/acme/risk');
    expect(sourceLabel('https://github.com/acme/risk/commit/abcdef0123')).toBe('acme/risk @ abcdef0');
  });

  it('free text shaped like a URL loses //user:secret@ and anything after ? or #', () => {
    expect(withoutCredentials('git+ssh://operator:CREDENTIAL@host/x?y=QUERYKEY')).not.toMatch(/CREDENTIAL|QUERYKEY/);
    expect(withoutCredentials('not a url //operator:CREDENTIAL@x #FRAGKEY')).toBe('not a url //x ');
  });

  it('repoLabel: a credential-bearing remote shows owner/repo; one that does not parse shows "your git remote"', () => {
    expect(repoLabel('https://operator:CREDENTIAL@github.com/acme/risk.git')).toBe('acme/risk');
    expect(repoLabel('git@github.com:acme/risk.git')).toBe('acme/risk');
    expect(repoLabel('operator:CREDENTIAL@')).toBe('your git remote');
    expect(repoLabel('https://operator:CREDENTIAL@')).toBe('your git remote');
  });
});

describe('next actions in text mode (Codex T21 r2 M2, m1)', () => {
  it('release_exists is not inline: its line does not hold the action, so text mode prints it', () => {
    const e = ERR.releaseExists('7', '0x' + '11'.repeat(32));
    expect(e.inline).toBe(false);
    expect(e.message).not.toContain('attessa status');
  });

  it('the last-resort line names the fallback next action and never the raw message', () => {
    const out = lastResortLines(new Error('boom CREDENTIAL'));
    expect(out).toBe(
      "Unexpected error (Error). Its message isn't printed, because it could contain a key.\n" +
        'Run the command again; if it fails the same way, report it at github.com/jesterkeri/attessa/issues with this line.\n',
    );
  });
});
