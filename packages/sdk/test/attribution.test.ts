import { afterEach, describe, expect, it } from 'vitest';
import { parseTransaction, type Hex } from 'viem';
import { makeWorld, type World } from './fakes/world.ts';

// The buyer's cancelAuthorization is a real transaction the CLI sends (`attessa cancel`): with `dataSuffix` set it
// ends with the suffix, without it the calldata is untouched.

const SUFFIX = '0x63656c6f5f7465737431323334' + '0d00' + '80218021802180218021802180218021';
let w: World;
afterEach(async () => {
  await w?.close();
});

async function cancelledData(dataSuffix?: Hex): Promise<Hex> {
  w = await makeWorld({ waitForExpiry: false, client: dataSuffix ? { dataSuffix } : {} });
  w.gw.behavior = { paid: 'refuse' };
  const r0 = await w.client.payAndVerify(w.url, { body: w.body });
  const raws: Hex[] = [];
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[] = []) => {
    if (m === 'eth_sendRawTransaction') raws.push(p[0] as Hex);
    return orig(m, p);
  };
  await w.client.cancelAuthorization(r0.requestId);
  expect(raws).toHaveLength(1);
  return parseTransaction(raws[0]!).data!;
}

describe('cancelAuthorization and the attribution suffix', () => {
  it('without dataSuffix the calldata is the plain cancel call', async () => {
    expect((await cancelledData()).endsWith(SUFFIX.slice(2))).toBe(false);
  });
  it('with dataSuffix the suffix is appended after the unchanged call', async () => {
    const plain = await cancelledData();
    await w.close();
    const tagged = await cancelledData(SUFFIX as Hex);
    expect(tagged.endsWith(SUFFIX.slice(2))).toBe(true);
    expect(tagged.slice(0, 10)).toBe(plain.slice(0, 10)); // same selector; the fake token accepted the call (cancel resolved)
  });
});
