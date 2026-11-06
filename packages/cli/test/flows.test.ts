import { describe, expect, it } from 'vitest';
import { flowsBlock, flowsOutput, flowsPattern, normalizeOutput } from './flows.ts';

// The snapshot matcher itself: it must accept the FLOWS text and reject any changed word.

describe('FLOWS matcher', () => {
  const j1 = flowsOutput(flowsBlock('### J1 happy path'), 'attessa call');

  it('reads the J1 block from FLOWS.md (output lines only, arrows stripped)', () => {
    expect(j1[0]).toBe('Checking risk.example before paying');
    expect(j1).toHaveLength(8);
  });

  it('accepts the text with other hex values, and rejects a changed word, a missing line or a reordering', () => {
    const re = flowsPattern(j1, [['0.4 s', '\\d+\\.\\d s']]);
    const ok = j1.map((l) => l.replace('0.4 s', '1.2 s').replace(/0x9c4e…a1/, '0x1234…ff'));
    expect(normalizeOutput(ok)).toMatch(re);
    expect(normalizeOutput(ok.map((l) => l.replace('approved build', 'approved bulid')))).not.toMatch(re);
    expect(normalizeOutput(ok.filter((_l, i) => i !== 3))).not.toMatch(re);
    expect(normalizeOutput([ok[1]!, ok[0]!, ...ok.slice(2)])).not.toMatch(re);
    expect(normalizeOutput(ok.map((l) => l.replace('0.02 USDC', '0.03 USDC')))).not.toMatch(re);
  });

  it('a slot that is not in the FLOWS text is an error, not a silent pass', () => {
    expect(() => flowsPattern(j1, [['14:02:11', '.*']])).toThrow(/not in the FLOWS text/);
  });
});
