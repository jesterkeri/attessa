import { afterEach, describe, expect, it } from 'vitest';
import { FacilitatorUnreachable, type Facilitator } from '../src/facilitator.ts';
import { TERMINAL_STATES } from '../src/db.ts';
import { makeHarness, type Harness } from './fakes/harness.ts';

let h: Harness;
let pump: NodeJS.Timeout | null = null;
afterEach(async () => {
  if (pump) clearInterval(pump);
  pump = null;
  await h?.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real milliseconds per chain second: the fake chain advances one block per tick of this pump. */
const MS_PER_S = 20;

async function scenario(graceS: number): Promise<{ state: string; reason: string | null; terminal: boolean }> {
  {
    // The facilitator is down in the way SPEC §6.2 step 11 plans for: every /settle runs into the 15 s
    // timeout. Time is scaled: 1 chain second = 20 ms, so the 15 s settle timeout is 300 ms and the
    // 5 s reconciler interval is 100 ms.
    let hang = false;
    h = await makeHarness({
      config: {
        timeouts: {
          executeMs: 400,
          settleMs: 400,
          receiptPollMs: 300,
          receiptPollIntervalMs: 20,
          maxRetryAfterMs: 1000,
          verifyMs: 2000,
          signerRefreshMs: 60_000,
          reconcileIntervalMs: 5 * MS_PER_S,
        },
      },
      wrapFacilitator: (f: Facilitator): Facilitator => ({
        verify: (r, t) => f.verify(r, t),
        supported: (t) => f.supported(t),
        settle: async (r, t) => {
          if (!hang) return f.settle(r, t);
          await sleep(15 * MS_PER_S);
          throw new FacilitatorUnreachable(true, 'facilitator /settle: TimeoutError');
        },
      }),
    });

    // Five paid calls whose handler send gets a 5xx: all end settle_pending (SPEC §6.2 step 11).
    // The first authorization is short (60 s); the other four are long (300 s).
    h.fac.settleScript = Array(5).fill({ kind: 'status', status: 500 });
    const first = await h.pay({ validBefore: h.clock.t + 60 });
    const r1 = await h.call(first);
    expect(r1.statusCode).toBe(202);
    const firstId = r1.headers['x-request-id'] as string;
    for (let i = 0; i < 4; i++) {
      const r = await h.call(await h.pay({ validBefore: h.clock.t + 300 }));
      expect(r.statusCode).toBe(202);
    }
    expect(h.rows().filter((r) => r.state === 'settle_pending')).toHaveLength(5);
    expect(h.chain.isUsed(first.accepted.asset, h.buyer, first.nonce)).toBe(false);

    // Chain time runs up to 3 s before the first authorization expires; the facilitator now hangs.
    h.chain.advance(first.validBefore - 3 - h.clock.t);
    hang = true;
    pump = setInterval(() => h.chain.advance(1), MS_PER_S);
    h.gw.reconciler.start();

    // INV-11: every row is terminal by validBefore + 60 s. The authorization was never used, so the
    // reconciler can prove it expired at any block with timestamp > validBefore + 5.
    const deadline = first.validBefore + graceS;
    while (h.clock.t < deadline) await sleep(MS_PER_S);
    clearInterval(pump);
    pump = null;
    const row = h.row(firstId)!;
    return { state: row.state, reason: row.reject_reason, terminal: TERMINAL_STATES.includes(row.state) };
  }
}

describe('adversary T19: INV-11 deadline under a hanging facilitator', () => {
  it('control: the never-used authorization does end settle_failed{expired}, given 100 s', async () => {
    expect(await scenario(100)).toEqual({ state: 'settle_failed', reason: 'expired', terminal: true });
  }, 20_000);

  it('INV-11: by validBefore + 60 s the row is terminal even while every re-send times out', async () => {
    expect(await scenario(60)).toEqual({ state: 'settle_failed', reason: 'expired', terminal: true });
  }, 20_000);
});
