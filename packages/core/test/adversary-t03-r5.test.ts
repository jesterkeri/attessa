import { describe, expect, it } from 'vitest';
import { URL } from 'whatwg-url';
import { OriginError, normalizeOrigin } from '../src/index.ts';
const reason = (i: string) => { try { return `ok ${normalizeOrigin(i)}`; } catch (e) { return e instanceof OriginError ? e.reason : String(e); } };
// SPEC §2.1 step 1: parse with WHATWG, then the scheme must be https. A non-special scheme has an
// opaque host, which WHATWG never runs through UTS-46, so `xn--ab-j1t` (punycode of "a" ZWNJ "b")
// parses. The oracle and rust-url 2.5.8 both parse it too; the refusal is not_https.
describe('adversary T03 r5: opaque host decoding to a ZWNJ', () => {
  it.each([['foo://xn--ab-j1t'], ['git://u@xn--ab-j1t:22/x'], ['foo://a.xn--ngb073k/x']])
    ('%j parses under WHATWG and is refused as not_https', (i) => {
      expect(() => new URL(i)).not.toThrow();
      expect(reason(i)).toBe('not_https');
    });
  it('control: https with the same host is invalid_url', () => { expect(reason('https://xn--ab-j1t')).toBe('invalid_url'); });
});
