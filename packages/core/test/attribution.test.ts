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
