import { describe, expect, it } from 'vitest';
import { OriginError, normalizeOrigin } from '../src/index.ts';
const reason = (i: string) => { try { return `ok ${normalizeOrigin(i)}`; } catch (e) { return e instanceof OriginError ? e.reason : String(e); } };
describe('adversary T03 r4: ContextJ on ZWNJ', () => {
  it.each([['https://ᠠ्‌ᠠ‌a.com'], ['https://ᠠ्‌ᠠ‌.com'], ['https://ᠠ्‌ᠠ्‌‌a.com']])
    ('refuses %j', (i) => { expect(reason(i)).toBe('invalid_url'); });
  it('control', () => { expect(reason('https://ᠠ‌ᠠ.com')).toBe('ok https://xn--26ea791d.com'); });
});
