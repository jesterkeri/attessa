import { describe, expect, it } from 'vitest';
import { concat, decodeFunctionData, encodeFunctionData, parseAbi, size, slice, toHex } from 'viem';
import { ERC8021_MARKER, attributionSuffix, isAttributionSuffix, withAttribution } from '../src/attribution.ts';

// ERC-8021 Schema 0, as celo-org/attribution-tags INDEXERS.md defines it:
//   [calldata] [code: N ASCII bytes] [length N: 1 byte] [schema: 0x00] [marker: 0x80218021 x 8]
const ascii = (s: string) => toHex(new TextEncoder().encode(s)).slice(2);

describe('attributionSuffix (ERC-8021 Schema 0)', () => {
  it('is code, one length byte, schema 0x00, then the 16-byte marker', () => {
    expect(ERC8021_MARKER).toBe('0x80218021802180218021802180218021');
    expect(attributionSuffix('celo_test1234')).toBe(`0x${ascii('celo_test1234')}0d0080218021802180218021802180218021`);
  });

  it('a one-character code is the 19-byte minimum', () => {
    expect(size(attributionSuffix('a'))).toBe(19);
  });

  it('refuses a code outside [a-z0-9_] of 1 to 32 characters', () => {
    for (const bad of ['', 'A', 'has space', 'a,b', 'é', 'x'.repeat(33)]) expect(() => attributionSuffix(bad)).toThrow(/attribution code/i);
  });
});

describe('withAttribution', () => {
  const abi = parseAbi(['function register(string agentURI) returns (uint256)', 'function transfer(address to, uint256 amount)']);

  it('appends the suffix after the calldata and changes nothing before it', () => {
    const data = encodeFunctionData({ abi, functionName: 'register', args: ['https://x.example/agent.json'] });
    const suffix = attributionSuffix('celo_test1234');
    const tagged = withAttribution(data, suffix);
    expect(tagged).toBe(concat([data, suffix]));
    expect(slice(tagged, 0, size(data))).toBe(data);
  });

  it('the appended bytes do not change the decoded function call (dynamic and static arguments)', () => {
    const suffix = attributionSuffix('celo_test1234');
    const a = encodeFunctionData({ abi, functionName: 'register', args: ['https://x.example/agent.json'] });
    const b = encodeFunctionData({ abi, functionName: 'transfer', args: ['0x00000000000000000000000000000000000000fe', 5n] });
    for (const data of [a, b]) expect(decodeFunctionData({ abi, data: withAttribution(data, suffix) })).toEqual(decodeFunctionData({ abi, data }));
  });

  it('a null suffix leaves the calldata as it was', () => {
    expect(withAttribution('0xdeadbeef', null)).toBe('0xdeadbeef');
  });
});

describe('isAttributionSuffix', () => {
  it('accepts a real suffix, in either hex case', () => {
    expect(isAttributionSuffix(attributionSuffix('a'))).toBe(true);
    expect(isAttributionSuffix(attributionSuffix('celo_test1234').toUpperCase().replace('0X', '0x') as `0x${string}`)).toBe(true);
  });
  it('rejects absent, empty, marker-less, bare-marker and non-hex values', () => {
    for (const bad of [undefined, null, '', '0x', '0x00', '0x63656c6f5f74657374313233340d00', ERC8021_MARKER, 'celo_test'] as const) expect(isAttributionSuffix(bad)).toBe(false);
  });
});

// Review r2, finding 1: only a well-formed Schema 0 suffix counts. The three OX_* vectors are what `ox/erc8021`
// (`Attribution.toDataSuffix({ codes: [code] })`, the upstream celo-org/attribution-tags reference) produces for those codes.
describe('isAttributionSuffix: Schema 0 shape', () => {
  const M = '80218021802180218021802180218021';
  const OX_ASSIGNED = '0x63656c6f5f333533663439303764313662110080218021802180218021802180218021'; // celo_353f4907d16b
  const OX_ONE = '0x61010080218021802180218021802180218021'; // a
  const OX_32 = '0x7878787878787878787878787878787878787878787878787878787878787878200080218021802180218021802180218021'; // x * 32

  it('accepts the upstream encoding of an assigned-shaped code, a 1-character code and a 32-character code', () => {
    expect(attributionSuffix('celo_353f4907d16b')).toBe(OX_ASSIGNED);
    expect(attributionSuffix('a')).toBe(OX_ONE);
    expect(attributionSuffix('x'.repeat(32))).toBe(OX_32);
    for (const ok of [OX_ASSIGNED, OX_ONE, OX_32]) expect(isAttributionSuffix(ok)).toBe(true);
  });

  it('rejects the review case: NUL code, length zero, schema zero, marker', () => {
    expect(isAttributionSuffix('0x00000080218021802180218021802180218021')).toBe(false);
  });

  it('rejects a length byte that is too big or too small', () => {
    const code = ascii('celo_test1234'); // 13 bytes = 0x0d
    for (const len of ['0e', '0c', '00', 'ff']) expect(isAttributionSuffix(`0x${code}${len}00${M}`)).toBe(false);
    expect(isAttributionSuffix(`0x${code}0d00${M}`)).toBe(true);
  });

  it('rejects a non-zero schema byte', () => {
    const code = ascii('celo_test1234');
    for (const schema of ['01', '80', 'ff']) expect(isAttributionSuffix(`0x${code}0d${schema}${M}`)).toBe(false);
  });

  it('rejects non-ASCII and uppercase codes even when length and schema agree', () => {
    expect(isAttributionSuffix(`0x${ascii('Celo_test')}0900${M}`)).toBe(false);
    expect(isAttributionSuffix(`0x${ascii('CELO')}0400${M}`)).toBe(false);
    expect(isAttributionSuffix(`0x${ascii('celo é')}0700${M}`)).toBe(false); // é is two bytes: 7 bytes in all
    expect(isAttributionSuffix(`0xc3a9c3a9c3a9${'03'}00${M}`)).toBe(false); // three bytes, none ASCII letters
    expect(isAttributionSuffix(`0xff0100${M}`)).toBe(false); // invalid UTF-8
  });

  it('rejects a code outside [a-z0-9_] such as a space, a dash or a dot', () => {
    for (const c of ['has space', 'a-b', 'a.b']) expect(isAttributionSuffix(`0x${ascii(c)}${c.length.toString(16).padStart(2, '0')}00${M}`)).toBe(false);
  });

  it('rejects a 33-byte code (length 0x21) and an empty code', () => {
    expect(isAttributionSuffix(`0x${ascii('x'.repeat(33))}2100${M}`)).toBe(false);
    expect(isAttributionSuffix(`0x0000${M}`)).toBe(false);
  });

  it('rejects a wrong total size: extra bytes before the code or after the marker, or a truncated marker', () => {
    expect(isAttributionSuffix(`0x1234${OX_ONE.slice(2)}`)).toBe(false);
    expect(isAttributionSuffix(`${OX_ONE}00`)).toBe(false);
    expect(isAttributionSuffix(OX_ONE.slice(0, -2) as `0x${string}`)).toBe(false);
  });

  it('is case-insensitive about the hex digits and still rejects odd-length and prefix-less input', () => {
    expect(isAttributionSuffix(OX_ASSIGNED.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(isAttributionSuffix(`${OX_ONE}0`)).toBe(false);
    expect(isAttributionSuffix(OX_ONE.slice(2))).toBe(false);
  });
});
