import { describe, expect, it } from 'vitest';
import { FrameError, FrameReader, MAX_FRAME, encodeFrame } from '../src/framing.ts';

describe('SPEC §4.2 framing', () => {
  it('prefixes a 4-byte big-endian length', () => {
    const f = encodeFrame(Buffer.from('{"type":"attest"}'));
    expect(f.readUInt32BE(0)).toBe(17);
    expect(f.subarray(4).toString()).toBe('{"type":"attest"}');
  });

  it('accepts exactly 65,536 bytes and refuses 0 or 65,537', () => {
    expect(encodeFrame(Buffer.alloc(MAX_FRAME, 0x20)).length).toBe(MAX_FRAME + 4);
    expect(() => encodeFrame(Buffer.alloc(0))).toThrow(FrameError);
    expect(() => encodeFrame(Buffer.alloc(MAX_FRAME + 1))).toThrow(FrameError);
  });

  it('reassembles frames split across chunks and splits concatenated frames', () => {
    const a = encodeFrame(Buffer.from('{"a":"1"}'));
    const b = encodeFrame(Buffer.from('{"b":"2"}'));
    const all = Buffer.concat([a, b]);
    const r = new FrameReader();
    const got: string[] = [];
    for (let i = 0; i < all.length; i += 3) got.push(...r.push(all.subarray(i, i + 3)).map((x) => x.toString()));
    expect(got).toEqual(['{"a":"1"}', '{"b":"2"}']);
    expect(r.pending).toBe(0);
  });

  it('breaks on a declared length of 0 or above the cap', () => {
    const zero = Buffer.alloc(4);
    expect(() => new FrameReader().push(zero)).toThrow(FrameError);
    const big = Buffer.alloc(4);
    big.writeUInt32BE(MAX_FRAME + 1, 0);
    const r = new FrameReader();
    expect(() => r.push(big)).toThrow(FrameError);
    expect(() => r.push(encodeFrame(Buffer.from('{}')))).toThrow(FrameError);
  });
});
