import { describe, expect, it } from 'vitest';
import { decodeAttestedProof } from '../src/index.ts';

// SPEC §2.5: X-Attested-Proof nests at most 32 levels, checked on the decoded text before
// parsing or the JCS comparison, and deeper input is refused as TooDeep. INV-18: TypeScript and
// Solidity give the same reason for every header. Solidity's iterative scanner says TooDeep for
// 3,400,000 `[` (a 4.5 MB header); TypeScript must not throw RangeError from the strict base64
// check before the depth check is reached.
describe('adversary: X-Attested-Proof of 3,400,000 brackets (SPEC §2.5, INV-18)', () => {
  it('is refused as too deep, not with a RangeError', () => {
    const header = Buffer.from('['.repeat(3_400_000), 'utf8').toString('base64');
    let err: unknown;
    try {
      decodeAttestedProof(header);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RangeError);
    expect((err as Error).message).toBe('X-Attested-Proof: too deep');
  });
});
