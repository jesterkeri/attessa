import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AlreadyUsedError } from '../../sdk/src/client.ts';
import { makeWorld, type World } from '../../sdk/test/fakes/world.ts';

// T21 adversary r16. SPEC §2.5: `X-Attest-Payer-Sig` is "Accepted within 300 s of gateway time". SPEC §7 "refused /
// uncertain -> final": settled on chain, getResult first; "no result and the call was refused -> settled_after_refusal".
// Here the gateway's clock (and its honest HTTP Date) runs 280 s ahead of the chain time the buyer reads. That is
// inside the 300 s window, so the gateway accepts the chain-time stamp, and its 404 result_not_found is genuine: it
// never stored an answer (it refused, then settled anyway). It accepts the re-signed stamp too (stamped at its own
// Date) and gives the same genuine 404. Both stamps were accepted under either reading of the Date (the gateway
// judging by its Date, or by chain time), yet fetchResult calls the answer `unsure` because 280 > 300 - 30, and the
// call stays `refused` for as long as the skew lasts: no settled_after_refusal row, ever.

let w: World;
afterEach(async () => w?.close());

const entries = (dir: string) =>
  readFileSync(join(dir, 'pending.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('a refused call that settled anyway, gateway clock 280 s ahead of chain time (inside the §2.5 window)', () => {
  it('getResult ends it settled_after_refusal (SPEC §7), not refused for as long as the skew lasts', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'refuse_but_settle' }; // §10 refusal, settles anyway, stores no answer
    const r0 = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r0.outcome).toBe('refused');
    const err = await w.client.cancelAuthorization(r0.requestId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlreadyUsedError); // the chain shows the settlement; the SDK records its tx

    // The gateway judges stamps by, and sends as Date, a clock 280 s ahead of the chain time the buyer reads.
    w.chain.advance(600);
    w.chain.headLag = 280;
    const first = await w.client.getResult(r0.requestId);
    w.chain.advance(600); // later, same skew
    const again = await w.client.getResult(r0.requestId);

    expect({ first: first.outcome, again: again.outcome, state: entries(w.dataDir)[0].state }).toEqual({
      first: 'settled_after_refusal',
      again: 'settled_after_refusal',
      state: 'settled_after_refusal',
    });
  });
});
