import { describe, expect, it } from 'vitest';
import { BUY, BUYERR, checkWords, safe, signedRefusal, sourceLabel } from '../src/copy.ts';

// adversary t21 r1: seller- and chain-supplied text is shown escaped, FLOWS text unchanged.
describe('safe(): untrusted text for a terminal', () => {
  it('leaves printable text, FLOWS samples included, byte-identical', () => {
    for (const s of ['github.com/acme/risk @ a1b2c3d', 'quote payTo 0xabc, registry payTo 0xdef', "the answer doesn't match → ok", 'résumé 日本']) expect(safe(s)).toBe(s);
    expect(BUY.ownerSays(sourceLabel('https://github.com/acme/risk/commit/a1b2c3d4e5'))).toBe("  Owner says it's built from acme/risk @ a1b2c3d  (not checked by attessa)");
  });

  it('escapes C0, C1, DEL, line separators and bidi controls', () => {
    expect(safe('a\rb\x1b[2Kc\x00d\x7fe\x9bf\tg\n')).toBe('a\\x0db\\x1b[2Kc\\x00d\\x7fe\\x9bf\\x09g\\x0a');
    expect(safe('x‮y z⁦')).toBe('x\\u{202e}y\\u{2028}z\\u{2066}');
  });

  it('applies to sourceRef, refusal details and codes', () => {
    expect(sourceLabel('evil\r\x1b[8m')).toBe('evil\\x0d\\x1b[8m');
    expect(signedRefusal('bad_request', 'no\rpe')).toContain('no\\x0dpe');
    expect(signedRefusal('x\x1b', 'd\x1b')).toContain('Refused: x\\x1b (d\\x1b).');
    expect(BUYERR.badRequest('a\x1bb').message).toContain('a\\x1bb');
  });

  it('checkWords finds only own entries', () => {
    expect(checkWords('response_hash_mismatch')?.[1]).toBe('response hash differs from the proof');
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', undefined]) expect(checkWords(k)).toBeUndefined();
  });
});
