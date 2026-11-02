import { afterEach, describe, expect, it } from 'vitest';
import type { Facilitator, FacilitatorAnswer } from '../src/facilitator.ts';
import { makeHarness, type Harness } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => h?.close());

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One paid call whose handler send gets a 5xx, so the row is `settle_pending` for the reconciler. */
async function pendingRow(validBeforeIn = 300): Promise<{ id: string; validBefore: number; nonce: `0x${string}`; asset: `0x${string}` }> {
  const p = await h.pay({ validBefore: h.clock.t + validBeforeIn });
  const r = await h.call(p);
  expect(r.statusCode).toBe(202);
  const id = r.headers['x-request-id'] as string;
  expect(h.row(id)!.state).toBe('settle_pending');
  return { id, validBefore: p.validBefore, nonce: p.nonce, asset: p.accepted.asset };
}

const resending = (): Map<string, Promise<void>> => (h.gw.reconciler as unknown as { resending: Map<string, Promise<void>> }).resending;

/**
 * A facilitator client whose reconciler sends can be held: while `hold` is set, `/settle` reaches the
 * fake facilitator (which acts on it) but its answer is delivered only when the test releases it.
 */
function holdable() {
  const s = {
    hold: false,
    sends: 0,
    held: [] as Array<() => void>,
    release() {
      for (const r of s.held.splice(0)) r();
    },
    wrap: (f: Facilitator): Facilitator => ({
      verify: (r, t) => f.verify(r, t),
      supported: (t) => f.supported(t),
      settle: async (r, t): Promise<FacilitatorAnswer> => {
        s.sends++;
        const answer = await f.settle(r, t);
        if (s.hold) await new Promise<void>((res) => s.held.push(res));
        return answer;
      },
    }),
  };
  return s;
}

describe('adversary T19 r2: background re-sends (SPEC §6.3 step 5, INV-11)', () => {
  it('a late 2xx re-send answer after chain evidence settled the row changes nothing, and /v1/results serves it', async () => {
    const f = holdable();
    h = await makeHarness({ wrapFacilitator: f.wrap });
    h.fac.settleScript = [{ kind: 'status', status: 500 }];
    const { id } = await pendingRow();

    f.hold = true;
    const first = h.gw.reconciler.tick(); // the re-send broadcasts (normal) but its answer is held
    await wait(50);
    expect(f.sends).toBe(2);

    await h.gw.reconciler.tick(); // the next pass is not held up and settles from the logs
    const settled = h.row(id)!;
    expect(settled).toMatchObject({ state: 'settled', reject_reason: null });

    h.clock.t += 3;
    f.release();
    await first;
    const after = h.row(id)!;
    expect(after).toMatchObject({ state: 'settled', reject_reason: null, settle_tx: settled.settle_tx, updated_at: settled.updated_at });
    expect(f.sends).toBe(2);
    expect((await h.results(id)).statusCode).toBe(200);
  });

  it('a late re-send answer after a front-run (value 0 to self) keeps settle_failed{nonce_used_elsewhere} and its tx', async () => {
    const f = holdable();
    h = await makeHarness({ wrapFacilitator: f.wrap });
    h.fac.settleScript = [{ kind: 'status', status: 500 }, { kind: 'status', status: 400, body: { success: false, errorReason: 'invalid_transaction_state' } }];
    const { id, nonce, asset } = await pendingRow();

    f.hold = true;
    const first = h.gw.reconciler.tick();
    await wait(50);
    const frontRun = h.chain.transferWithAuthorization(asset, h.buyer, h.buyer, 0n, nonce);
    await h.gw.reconciler.tick();
    expect(h.row(id)!).toMatchObject({ state: 'settle_failed', reject_reason: 'nonce_used_elsewhere', settle_tx: frontRun.toLowerCase(), payment_payload: null });

    f.release();
    await first;
    expect(h.row(id)!).toMatchObject({ state: 'settle_failed', reject_reason: 'nonce_used_elsewhere', settle_tx: frontRun.toLowerCase() });
    expect(f.sends).toBe(2);
  });

  it('in-flight tracking does not leak: once a hung re-send times out, the next pass re-sends the row', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500 }, { kind: 'hang' }, { kind: 'status', status: 500 }];
    const { id } = await pendingRow();
    await h.gw.reconciler.tick(); // waits for the hung re-send to time out
    expect(h.row(id)!.reject_reason).toBe('timeout');
    expect(resending().size).toBe(0);
    await h.gw.reconciler.tick();
    expect(h.fac.settleCalls).toBe(3);
    expect(h.row(id)!).toMatchObject({ state: 'settle_pending', reject_reason: 'http_500' });
    expect(resending().size).toBe(0);
  });

  it('two concurrent ticks share one pass: one re-send per row', async () => {
    const f = holdable();
    h = await makeHarness({ wrapFacilitator: f.wrap });
    h.fac.settleScript = [{ kind: 'status', status: 500 }, { kind: 'status', status: 500 }, { kind: 'status', status: 500 }];
    await pendingRow();
    await pendingRow();
    f.hold = true;
    const a = h.gw.reconciler.tick();
    const b = h.gw.reconciler.tick();
    await wait(50);
    expect(f.sends).toBe(4); // 2 handler sends + one re-send per row
    f.release();
    await Promise.all([a, b]);
    expect(f.sends).toBe(4);
  });

  it('a corrupt stored payload: no unhandled rejection, no leak, and expiry still terminalizes the row', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500 }];
    const { id, validBefore } = await pendingRow();
    h.db.db.prepare(`UPDATE calls SET payment_payload = 'not-base64-json' WHERE request_id = ?`).run(id);
    const unhandled: unknown[] = [];
    const onU = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onU);
    try {
      await h.gw.reconciler.tick();
      await wait(20);
      expect(resending().size).toBe(0);
      expect(h.logs.some((l) => l.event === 'reconcile_error' && l.requestId === id)).toBe(true);
      h.chain.advance(validBefore + 6 - h.clock.t);
      await h.gw.reconciler.tick();
      expect(h.row(id)!).toMatchObject({ state: 'settle_failed', reject_reason: 'expired' });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onU);
    }
  });

  it('stop() during a pass waits for a re-send that pass starts after stop() was called', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500 }, { kind: 'hang' }];
    const { id } = await pendingRow();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const realLatest = h.chain.latestBlock.bind(h.chain);
    h.chain.latestBlock = async () => {
      await gate;
      return realLatest();
    };
    void h.gw.reconciler.tick();
    await wait(10);
    let stopped = false;
    const stopping = h.gw.reconciler.stop().then(() => (stopped = true));
    await wait(10);
    open();
    await wait(50);
    expect(h.fac.settleCalls).toBe(2);
    expect(stopped).toBe(false);
    await stopping;
    expect(h.row(id)!).toMatchObject({ state: 'settle_pending', reject_reason: 'timeout' });
    expect(resending().size).toBe(0);
  });

  it('measured: a slow 402 no longer stops later rows of the same pass from being re-sent (paused was false at each send)', async () => {
    let slow = false;
    let sends = 0;
    h = await makeHarness({
      wrapFacilitator: (f: Facilitator): Facilitator => ({
        verify: (r, t) => f.verify(r, t),
        supported: (t) => f.supported(t),
        settle: async (r, t) => {
          sends++;
          if (!slow) return f.settle(r, t);
          await wait(50);
          return { status: 402, body: {}, retryAfter: null };
        },
      }),
    });
    h.fac.settleScript = Array(3).fill({ kind: 'status', status: 500 });
    for (let i = 0; i < 3; i++) await pendingRow();
    slow = true;
    const before = sends;
    await h.gw.reconciler.tick();
    // Serial (67e0122): 1 send, then rows 2 and 3 saw paused. Background (b76a43d): all 3 are sent.
    expect(sends - before).toBe(3);
    expect(h.db.isPaused()).toBe(true);
  });

  it('measured: gateway start() still waits for the startup pass re-sends (one settle timeout)', async () => {
    h = await makeHarness();
    h.fac.settleScript = [{ kind: 'status', status: 500 }, { kind: 'hang' }];
    const { id } = await pendingRow();
    const t0 = performance.now();
    await h.gw.start();
    const ms = performance.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(380); // settleMs = 400 in the harness
    expect(h.row(id)!.reject_reason).toBe('timeout');
  });

  it('a 402 from a background re-send pauses: the next pass sends nothing', async () => {
    const f = holdable();
    h = await makeHarness({ wrapFacilitator: f.wrap });
    h.fac.settleScript = [{ kind: 'status', status: 500 }, { kind: 'status', status: 402 }, { kind: 'status', status: 402 }];
    await pendingRow();
    await h.gw.reconciler.tick();
    expect(h.db.isPaused()).toBe(true);
    const before = f.sends;
    await h.gw.reconciler.tick();
    expect(f.sends).toBe(before);
  });
});
