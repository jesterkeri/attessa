import { afterEach, describe, expect, it } from 'vitest';
import { authorizationTopics } from '../src/chain.ts';
import { makeHarness, type Harness, type Payment } from './fakes/harness.ts';

let h: Harness;
let release: () => void = () => {};
afterEach(async () => {
  release();
  await h?.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TERMINAL = ['delivered', 'delivery_failed', 'exec_failed', 'proof_rejected', 'too_late', 'settle_failed'];

describe('reconciler with a slow RPC (SPEC §6.3 every 5 s, INV-11)', () => {
  it('getLogs taking 10 s on 6 open rows: every row terminal by validBefore + 60 s, delivery_failed within its bound, nonce never used', async () => {
    h = await makeHarness();
    // 1 handler 5xx after broadcast for the row that will settle, 500 for the 6 open rows, 500 for every re-send.
    h.fac.settleScript = [{ kind: 'status', status: 503, broadcast: true }, ...Array(200).fill({ kind: 'status', status: 500 })];

    const s = await h.call(await h.pay());
    expect(s.statusCode).toBe(202);
    const settledId = s.headers['x-request-id'] as string;
    await h.gw.reconciler.tick(); // fast chain: settled now
    expect(h.row(settledId)!.state).toBe('settled');
    const t0 = h.clock.t;

    const validBefore = t0 + 45;
    const open: Array<{ id: string; p: Payment }> = [];
    for (let i = 0; i < 6; i++) {
      const p = await h.pay({ validBefore });
      const r = await h.call(p);
      expect(r.statusCode).toBe(202);
      open.push({ id: r.headers['x-request-id'] as string, p });
    }
    expect(h.clock.t).toBe(t0);

    // Every getLogs answers 10 virtual seconds after it was asked.
    const sleepers: Array<{ until: number; go: () => void }> = [];
    let fast = false;
    release = () => {
      fast = true;
      for (const z of sleepers.splice(0)) z.go();
    };
    const getLogs = h.chain.getLogs.bind(h.chain);
    h.chain.getLogs = async (...a) => {
      if (!fast) await new Promise<void>((go) => sleepers.push({ until: h.clock.t + 10, go }));
      return getLogs(...a);
    };

    // The interval timer: a tick every 5 s that is never awaited. One block per second.
    let deliveryFailedAt: number | null = null;
    const terminalAt = new Map<string, number>();
    while (h.clock.t < validBefore + 60) {
      h.chain.advance(1);
      for (const z of sleepers.filter((x) => x.until <= h.clock.t)) {
        sleepers.splice(sleepers.indexOf(z), 1);
        z.go();
      }
      if ((h.clock.t - t0) % 5 === 0) void h.gw.reconciler.tick();
      await wait(15);
      if (deliveryFailedAt === null && h.row(settledId)!.state === 'delivery_failed') deliveryFailedAt = h.clock.t;
      for (const o of open) if (!terminalAt.has(o.id) && TERMINAL.includes(h.row(o.id)!.state)) terminalAt.set(o.id, h.clock.t);
    }

    // settled at t0, swept on the first 5 s tick past the 30 s grace.
    expect(deliveryFailedAt).not.toBeNull();
    expect(deliveryFailedAt!).toBeLessThanOrEqual(t0 + 30 + 5 + 1);
    for (const o of open) {
      expect(h.row(o.id)!).toMatchObject({ state: 'settle_failed', reject_reason: 'expired', payment_payload: null });
      expect(terminalAt.get(o.id)!).toBeLessThanOrEqual(validBefore + 60);
      const used = await getLogs(o.p.accepted.asset, authorizationTopics('AuthorizationUsed', o.p.from, o.p.nonce), 0n);
      expect(used).toHaveLength(0);
    }
  });

  it('every chain read takes 20 s (10 s timeout + one retry): rows with every validBefore phase are terminal by validBefore + 60 s', async () => {
    h = await makeHarness();
    h.fac.settleScript = Array(400).fill({ kind: 'status', status: 500 });
    const t0 = h.clock.t;
    // validBefore at every second of a 20 s call cycle and of the 5 s tick.
    const open: Array<{ id: string; validBefore: number }> = [];
    for (let i = 0; i < 20; i++) {
      const validBefore = t0 + 45 + i;
      const r = await h.call(await h.pay({ validBefore }));
      expect(r.statusCode).toBe(202);
      open.push({ id: r.headers['x-request-id'] as string, validBefore });
    }
    expect(h.clock.t).toBe(t0);

    // Each read answers 20 virtual seconds after it was asked, with the chain as it is then.
    const sleepers: Array<{ until: number; go: () => void }> = [];
    let fast = false;
    release = () => {
      fast = true;
      for (const z of sleepers.splice(0)) z.go();
    };
    const slow = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
      if (!fast) await new Promise<void>((go) => sleepers.push({ until: h.clock.t + 20, go }));
      return f(...a);
    };
    h.chain.getLogs = slow(h.chain.getLogs.bind(h.chain));
    h.chain.latestBlock = slow(h.chain.latestBlock.bind(h.chain));
    h.chain.authorizationState = slow(h.chain.authorizationState.bind(h.chain));

    const terminalAt = new Map<string, number>();
    const end = t0 + 45 + 19 + 61;
    while (h.clock.t < end) {
      h.chain.advance(1);
      for (const z of sleepers.filter((x) => x.until <= h.clock.t)) {
        sleepers.splice(sleepers.indexOf(z), 1);
        z.go();
      }
      if ((h.clock.t - t0) % 5 === 0) void h.gw.reconciler.tick();
      await wait(15);
      for (const o of open) if (!terminalAt.has(o.id) && TERMINAL.includes(h.row(o.id)!.state)) terminalAt.set(o.id, h.clock.t);
    }

    const late = open.filter((o) => !(terminalAt.get(o.id)! <= o.validBefore + 60)).map((o) => o.validBefore - t0);
    expect(late).toEqual([]);
    for (const o of open) expect(h.row(o.id)!).toMatchObject({ state: 'settle_failed', reject_reason: 'expired' });
  });
});
