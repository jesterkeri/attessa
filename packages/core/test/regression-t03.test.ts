import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OriginError, decodeAttestedProof, normalizeOrigin } from '../src/index.ts';

// SPEC §2.1: host is UTS-46 non-transitional per the WHATWG URL Standard, whose
// domain-to-ASCII sets CheckBidi=true. A label whose first character is an
// Arabic-Indic digit (Bidi class AN) breaks RFC 5893 rule 1, and a Latin label
// containing one breaks rule 5. Both reference implementations refuse these hosts:
//   whatwg-url 14.2.0 (tr46 5.1.1): new URL('https://xn--9hbc.com') throws
//   Rust url 2.5.8 (idna 1.1.0):    Url::parse -> "invalid international domain name"
// so a Rust enclave (T13) can never configure the origin the TS SDK hashes.
describe('adversary: origin CheckBidi (SPEC §2.1, INV-18)', () => {
  const ar12 = String.fromCodePoint(0x661, 0x662);
  for (const input of [`https://${ar12}.com`, 'https://xn--9hbc.com', `https://a${String.fromCodePoint(0x661)}.com`]) {
    it(`refuses ${JSON.stringify(input)}`, () => {
      expect(() => normalizeOrigin(input)).toThrow(OriginError);
    });
  }
});

// SPEC §2.5: X-Attested-Proof is "base64 of JCS {...}". UTF-8 bytes EF BB BF
// followed by the JCS text are not JCS, and a strict parser (serde_json) refuses them.
describe('adversary: X-Attested-Proof with a UTF-8 BOM (SPEC §2.5)', () => {
  it('refuses base64(BOM + JCS)', () => {
    const dir = fileURLToPath(new URL('../../../vectors/', import.meta.url));
    const good = JSON.parse(readFileSync(dir + 'headers.json', 'utf8')).attestedProof.valid[0];
    const header = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(good.json, 'utf8')]).toString('base64');
    expect(header).not.toBe(good.header);
    expect(() => decodeAttestedProof(header)).toThrow();
  });
});
