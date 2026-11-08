import { afterEach, describe, expect, it } from 'vitest';
import { parseTransaction, toFunctionSelector, type Hex } from 'viem';
import { makeWorld, type World } from './fakes/world.ts';

// The buyer's cancelAuthorization is a real transaction the CLI sends (`attessa cancel`). The suffix is appended only
// when the VERIFIED chain id is 42220 (Celo mainnet), where a missing or malformed suffix is refused before anything
// is signed (review r1, finding 2). Other chains never carry it.

const SUFFIX = '0x63656c6f5f7465737431323334' + '0d00' + '80218021802180218021802180218021';
let w: World;
afterEach(async () => {
  await w?.close();
});

async function open(mainnet: boolean, dataSuffix?: string) {
  w = await makeWorld({ waitForExpiry: false, mainnet, client: dataSuffix === undefined ? {} : { dataSuffix: dataSuffix as Hex } });
  w.gw.behavior = { paid: 'refuse' };
  const r0 = await w.client.payAndVerify(w.url, { body: w.body });
  const raws: Hex[] = [];
  const methods: string[] = [];
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[] = []) => {
    methods.push(m);
    if (m === 'eth_sendRawTransaction') raws.push(p[0] as Hex);
    return orig(m, p);
  };
  return { id: r0.requestId, raws, methods };
}

async function cancelledData(mainnet: boolean, dataSuffix?: string): Promise<Hex> {
  const { id, raws } = await open(mainnet, dataSuffix);
  await w.client.cancelAuthorization(id);
  expect(raws).toHaveLength(1);
  return parseTransaction(raws[0]!).data!;
}

describe('cancelAuthorization and the attribution suffix', () => {
  it('on another chain the calldata is the plain cancel call, even when a suffix is given', async () => {
    const plain = await cancelledData(false);
    await w.close();
    const given = await cancelledData(false, SUFFIX);
    expect(given.endsWith(SUFFIX.slice(2))).toBe(false);
    expect(given.length).toBe(plain.length);
  });

  it('on chain 42220 with a valid suffix it is appended after the unchanged call', async () => {
    const tagged = await cancelledData(true, SUFFIX);
    expect(tagged.endsWith(SUFFIX.slice(2))).toBe(true);
    expect(tagged.slice(0, 10)).toBe(toFunctionSelector('cancelAuthorization(address,bytes32,uint8,bytes32,bytes32)')); // the call is unchanged and the fake token accepted it
  });

  for (const [label, suffix] of [
    ['no suffix', undefined],
    ['an empty suffix (0x)', '0x'],
    ['a suffix without the ERC-8021 marker', '0x63656c6f5f74657374313233340d00'],
    ['only the marker, no code', '0x80218021802180218021802180218021'],
  ] as const) {
    it(`on chain 42220 with ${label}: no_attribution_tag, nothing estimated, signed or sent`, async () => {
      const { id, raws, methods } = await open(true, suffix);
      const signs = w.signSpy.mock.calls.length;
      await expect(w.client.cancelAuthorization(id)).rejects.toMatchObject({ code: 'no_attribution_tag' });
      expect(raws).toHaveLength(0);
      expect(methods).not.toContain('eth_estimateGas');
      expect(w.signSpy.mock.calls.length).toBe(signs); // not even the cancel permission
    });
  }
});
