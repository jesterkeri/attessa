import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OriginError, normalizeOrigin, parsePayerSig } from '../src/index.ts';

// Adversary T03 r3. Attacks scripts/check-vectors-oracle.py (the r2 fix) and the vector set.
// Ground truth for every host below is two implementations that share no code with the oracle:
// core (whatwg-url 14.2.0, tr46 5.1.1) and Rust url 2.5.8 / idna 1.1.0, built offline by
// scripts/adversary-t03-r3/rust-url. Both agree on every input used here.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ORACLE = join(ROOT, 'scripts/check-vectors-oracle.py');
const FILES = ['origins.json', 'hashes.json', 'binding.json', 'eip712.json', 'headers.json'];
const read = (f: string) => JSON.parse(readFileSync(join(ROOT, 'vectors', f), 'utf8'));
const keccakStr = (s: string) => execFileSync('cast', ['keccak', `0x${Buffer.from(s, 'utf8').toString('hex')}`], { encoding: 'utf8' }).trim();

/** Runs the oracle on the committed vectors plus `extra` cases appended to origins.json `valid`. */
function oracleWithValidOrigin(extra: { name: string; input: string; normalized: string }): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'adv-t03-r3-'));
  try {
    mkdirSync(join(dir, 'vectors'));
    for (const f of FILES) {
      const v = read(f);
      if (f === 'origins.json') {
        v.valid.push({ ...extra, local: false, originHash: keccakStr(extra.normalized), bytes: Buffer.byteLength(extra.normalized) });
      }
      writeFileSync(join(dir, 'vectors', f), JSON.stringify(v, null, 2));
    }
    const r = spawnSync('python3', ['-I', ORACLE], { cwd: dir, encoding: 'utf8' });
    return { status: r.status, out: (r.stdout + r.stderr).trim().split('\n').slice(-3).join('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const reason = (input: string) => {
  try {
    return `ok:${normalizeOrigin(input)}`;
  } catch (e) {
    return e instanceof OriginError ? e.reason : String(e);
  }
};

describe('adversary: the oracle origin check is not UTS-46 (SPEC §2.1 step 2, INV-18)', () => {
  // A wrong vector: UTS-46 disallows U+FFFD (here from %FF, invalid UTF-8) and U+2FF0, so a
  // conforming parser refuses these hosts. The oracle's NFKC+lowercase approximation accepts them.
  it.each([
    { name: 'adv r3: %FF host (wrong, UTS-46 disallows U+FFFD)', input: 'https://%ff.com', normalized: 'https://xn--zn7c.com' },
    { name: 'adv r3: U+2FF0 host (wrong, UTS-46 disallows it)', input: 'https://⿰.com', normalized: 'https://xn--85j.com' },
  ])('oracle exits 1 on $name', (extra) => {
    expect(reason(extra.input)).toBe('invalid_url'); // core and rust-url both refuse it
    const r = oracleWithValidOrigin(extra);
    expect(r.status, r.out).toBe(1);
  });

  // A right vector: UTS-46 maps U+1F80 to U+1F00 U+03B9 (case folding), so core and rust-url
  // both give xn--uxa970l. The oracle keeps U+1F80 (xn--0qg) and fails a correct vector.
  it('oracle exits 0 on a correct U+1F80 vector', () => {
    const extra = { name: 'adv r3: U+1F80 host', input: 'https://ᾀ.com', normalized: 'https://xn--uxa970l.com' };
    expect(reason(extra.input)).toBe(`ok:${extra.normalized}`);
    const r = oracleWithValidOrigin(extra);
    expect(r.status, r.out).toBe(0);
  });
});

describe('adversary: core mutants that change no vector (INV-18 coverage)', () => {
  // Mutant: origin.ts checks only url.username. Every core test, oracle.test.ts, vectors.test.ts
  // and check-vectors-oracle.py still pass (run in scripts/adversary-t03-r3/vitest.mutant.config.ts).
  it('core refuses a password-only userinfo (passes on core, kills the mutant)', () => {
    expect(reason('https://:pw@example.com')).toBe('userinfo');
  });
  it('origins.json invalid covers a password-only userinfo', () => {
    const inv = read('origins.json').invalid as { input: string; reason: string }[];
    expect(inv.some((c) => c.reason === 'userinfo' && /^https:\/\/:[^@]+@/.test(c.input))).toBe(true);
  });

  // Mutant: headers.ts drops the Number.isSafeInteger bound. 9007199254740993 then parses as
  // ...992, so the payer message differs from the signed text. The oracle has the bound, but
  // no vector reaches it, so the mutant survives every suite.
  const sig = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
  it('core refuses payer-sig seconds above 2^53 - 1 (passes on core, kills the mutant)', () => {
    expect(parsePayerSig(`9007199254740993.${sig}`)).toBeNull();
  });
  it('headers.json payerSig.invalid covers seconds above 2^53 - 1', () => {
    const inv = read('headers.json').payerSig.invalid as { header: string }[];
    expect(inv.some((c) => BigInt(c.header.split('.')[0] || '0') > 2n ** 53n - 1n)).toBe(true);
  });
});
