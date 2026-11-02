import type { Hex } from 'viem';
import { authorizationTopics, isAuthorizationUsed, receiptSettles, type Chain } from './chain.ts';
import type { GatewayConfig } from './config.ts';
import { RESULT_RETENTION_S, type CallRow, type CallStore } from './db.ts';
import { FacilitatorUnreachable, type Facilitator } from './facilitator.ts';
import { classifySettle, targetOf } from './settle.ts';

/** SPEC §6.3: a `settling` row is re-sent only once the handler's own send is surely over. */
export const SETTLING_RESEND_AFTER_S = 20;
/** SPEC §6.3: `settled` with no live response for longer than this → `delivery_failed`. */
export const DELIVERY_GRACE_S = 30;
/**
 * INV-11: a `settled` row with no live response is `delivery_failed` once now > validBefore + this, even
 * inside the grace (a row the reconciler settles late, after a lagging log index). Leaves one 5 s pass of
 * slack before validBefore + 60 s.
 */
export const DELIVERY_DEADLINE_S = 50;
/**
 * INV-11 over a live mark: a `settled` row still marked live is `delivery_failed` once now > validBefore + this.
 * A handler's settle ends by about validBefore + 15 (SPEC §6.2 steps 10-11) and its write takes milliseconds,
 * so a mark left 40 s later is one nothing will release; a pass every 5 s still lands by validBefore + 60.
 */
export const LIVE_DEADLINE_S = 55;
/** SPEC §6.3 step 4 / INV-11: expiry is judged only at a block whose timestamp exceeds validBefore + 5. */
export const EXPIRY_MARGIN_S = 5;

export interface ReconcilerDeps {
  cfg: GatewayConfig;
  db: CallStore;
  chain: Chain;
  facilitator: Facilitator;
  now: () => number;
  /** Rows whose settle the request handler is sending right now (never re-sent by the reconciler). */
  sending: ReadonlySet<string>;
  /** Rows a request handler is answering right now (their `settled` → `delivered` is the handler's). */
  live: { has(requestId: string): boolean };
  log: (event: string, fields: Record<string, unknown>) => void;
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<Promise<void>[]> | null = null;
  /**
   * Re-sends in flight, by request id. A pass starts them and does not wait, so a facilitator that hangs
   * for the full settle timeout never delays the next pass's chain checks (SPEC §6.3 every 5 s, INV-11).
   * A row with a re-send in flight is not sent again: at most one reconciler send per row at a time.
   */
  private readonly resending = new Map<string, Promise<void>>();
  /**
   * Chain checks in flight, by request id. A pass starts one per open row and does not wait, so a slow RPC
   * on one row never delays another row's expiry or the delivery sweep (SPEC §6.3 every 5 s, INV-11).
   * shortcut: no global cap on concurrent row checks; add one if open rows ever number in the hundreds.
   */
  private readonly checking = new Map<string, Promise<void>>();
  /**
   * When a pass first saw each open or settled row with no live handler: the start of "no live response"
   * for the 30 s delivery grace. Never earlier than the handler's end, so a delivery is never cut short;
   * a row the reconciler settles long after the handler's 202 is finished at once (INV-11).
   */
  private readonly unwatchedSince = new Map<string, number>();

  private readonly d: ReconcilerDeps;
  constructor(d: ReconcilerDeps) {
    this.d = d;
    // A new process: none of its handlers answers any row yet, and no handler of an earlier process ever
    // will again. The rows already open count "no live response" from their last stored write (the latest
    // moment on record; a crash time is not stored), so a restart never hands them a fresh 30 s.
    for (const row of d.db.inStates(['settling', 'settle_pending', 'settled'])) this.unwatchedSince.set(row.request_id, row.updated_at);
  }

  /** SPEC §6.3 at startup: rows left in `payment_verified` / `executing` by a crash → `exec_failed`, never settled. */
  startupSweep(): number {
    let n = 0;
    for (const row of this.d.db.inStates(['payment_verified', 'executing'])) {
      if (this.d.db.transition(row.request_id, ['payment_verified', 'executing'], 'exec_failed', this.d.now(), { reject_reason: 'enclave_unavailable' })) {
        n++;
        this.d.log('startup_exec_failed', { requestId: row.request_id });
      }
    }
    return n;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.d.cfg.timeouts.reconcileIntervalMs);
    this.timer.unref();
  }

  /** Stops the timer and waits for the pass and every re-send in flight, so nothing writes after close. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
    await Promise.all(this.checking.values()); // before re-sends: a check can still start one
    await Promise.all(this.resending.values());
  }

  /**
   * One pass. Concurrent calls share the pass in flight. The returned promise also waits for the row checks
   * and re-sends that pass started; the timer ignores it, so the next pass is never held up by a slow RPC
   * or facilitator.
   */
  async tick(): Promise<void> {
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = null;
      });
    }
    await Promise.all(await this.running);
  }

  private async pass(): Promise<Promise<void>[]> {
    const { db } = this.d;
    const started: Promise<void>[] = [];
    this.track(this.d.now());
    for (const row of db.inStates(['settling', 'settle_pending'])) {
      const id = row.request_id;
      const inFlight = this.checking.get(id);
      if (inFlight) {
        started.push(inFlight);
        continue;
      }
      const checked = this.reconcileSettlement(row)
        .catch((e: unknown) => {
          this.d.log('reconcile_error', { requestId: id, error: (e as Error).message });
          return null;
        })
        .finally(() => {
          this.checking.delete(id);
          // A row this check settled late, or terminalized: finish it now, not a pass later.
          this.sweepDelivered(this.d.now());
          db.applyRetention(this.d.now());
        });
      this.checking.set(id, checked.then(() => undefined));
      started.push(checked.then((r) => r?.sent));
    }
    const now = this.d.now();
    this.sweepDelivered(now);
    db.applyRetention(now);
    return started;
  }

  private track(now: number): void {
    const rows = this.d.db.inStates(['settling', 'settle_pending', 'settled']);
    const ids = new Set(rows.map((r) => r.request_id));
    for (const id of this.unwatchedSince.keys()) if (!ids.has(id)) this.unwatchedSince.delete(id);
    for (const { request_id: id } of rows) {
      if (this.d.live.has(id)) this.unwatchedSince.delete(id);
      else if (!this.unwatchedSince.has(id)) this.unwatchedSince.set(id, now);
    }
  }

  /**
   * SPEC §6.3: `settled` with no live response for > 30 s, or past the INV-11 deadline → `delivery_failed`.
   * A row marked live is left to its handler until LIVE_DEADLINE_S, never past it.
   */
  private sweepDelivered(now: number): void {
    for (const row of this.d.db.inStates(['settled'])) {
      const id = row.request_id;
      if (this.d.live.has(id)) {
        if (now > row.valid_before + LIVE_DEADLINE_S) this.d.db.transition(id, ['settled'], 'delivery_failed', now);
        continue;
      }
      const since = this.unwatchedSince.get(id) ?? now;
      this.unwatchedSince.set(id, since);
      if (now - since > DELIVERY_GRACE_S || now > row.valid_before + DELIVERY_DEADLINE_S) {
        this.d.db.transition(id, ['settled'], 'delivery_failed', now);
      }
    }
  }

  /**
   * SPEC §6.3 steps 1–5 for one `settling` / `settle_pending` row. Only chain evidence terminalizes.
   * Returns the step 5 re-send it started, if any, without waiting for it (boxed: an async function
   * returning a bare promise would adopt it and wait).
   */
  private async reconcileSettlement(row: CallRow): Promise<{ sent: Promise<void> } | null> {
    const { chain, db } = this.d;
    const t = targetOf(row);
    const fromBlock = BigInt(row.created_block);
    // The three reads of steps 1, 3 and 4 run together: one slow RPC call then costs one timeout, not three,
    // which keeps a row inside validBefore + 60 s (INV-11). The expiry verdict rests only on
    // authorizationState at H, so reading H alongside the log queries is safe.
    const [used, cancelled, head] = await Promise.all([
      chain.getLogs(t.asset, authorizationTopics('AuthorizationUsed', t.payer, t.nonce), fromBlock),
      chain.getLogs(t.asset, authorizationTopics('AuthorizationCanceled', t.payer, t.nonce), fromBlock),
      chain.latestBlock(),
    ]);
    // 1–2. AuthorizationUsed(payer, nonce) from the row's asset, then the same tx must carry the Transfer.
    const usedLog = used.find((l) => isAuthorizationUsed(l, t));
    if (usedLog) {
      const receipt = await chain.receipt(usedLog.transactionHash);
      if (!receipt) return null; // log seen, receipt not served yet: next tick
      const now = this.d.now();
      if (receiptSettles(receipt, t)) {
        db.transition(row.request_id, ['settling', 'settle_pending'], 'settled', now, {
          settle_tx: usedLog.transactionHash.toLowerCase(),
          reject_reason: null,
          result_expires_at: now + RESULT_RETENTION_S,
        });
        this.d.log('settled', { requestId: row.request_id, tx: usedLog.transactionHash });
      } else {
        db.transition(row.request_id, ['settling', 'settle_pending'], 'settle_failed', now, {
          reject_reason: 'nonce_used_elsewhere',
          settle_tx: usedLog.transactionHash.toLowerCase(),
        });
        this.d.log('settle_failed', { requestId: row.request_id, reason: 'nonce_used_elsewhere' });
      }
      return null;
    }
    // 3. AuthorizationCanceled(payer, nonce).
    if (cancelled.length > 0) {
      db.transition(row.request_id, ['settling', 'settle_pending'], 'settle_failed', this.d.now(), { reject_reason: 'cancelled' });
      this.d.log('settle_failed', { requestId: row.request_id, reason: 'cancelled' });
      return null;
    }
    // 4. Expiry, judged at a block past validBefore + 5.
    if (head.timestamp > BigInt(row.valid_before + EXPIRY_MARGIN_S)) {
      const isUsed = await chain.authorizationState(t.asset, t.payer, t.nonce, head.number);
      if (!isUsed) {
        db.transition(row.request_id, ['settling', 'settle_pending'], 'settle_failed', this.d.now(), { reject_reason: 'expired' });
        this.d.log('settle_failed', { requestId: row.request_id, reason: 'expired' });
      }
      return null; // used but the log query is behind: next tick
    }
    // 5. Retry from the stored payload. The answer is recorded, never acted on as a terminal outcome.
    // Decide from the row as it is now, not as the pass read it: during the reads above the handler's own
    // send may have landed and moved the row on. Steps 1-4 need no re-read: db.transition checks the state.
    const id = row.request_id;
    const cur = db.byRequestId(id);
    if (!cur || (cur.state !== 'settling' && cur.state !== 'settle_pending')) return null;
    if (db.isPaused() || this.d.sending.has(id) || this.resending.has(id)) return null;
    if (!cur.payment_payload || !cur.requirements) return null;
    if (cur.state === 'settling' && this.d.now() - cur.updated_at <= SETTLING_RESEND_AFTER_S) return null;
    const sent = this.resend(cur)
      .catch((e: unknown) => this.d.log('reconcile_error', { requestId: id, error: (e as Error).message }))
      .finally(() => this.resending.delete(id));
    this.resending.set(id, sent);
    return { sent };
  }

  private async resend(row: CallRow): Promise<void> {
    const { db } = this.d;
    const paymentPayload: unknown = JSON.parse(Buffer.from(row.payment_payload as string, 'base64').toString('utf8'));
    const paymentRequirements: unknown = JSON.parse(row.requirements as string);
    if (row.state === 'settling') db.transition(row.request_id, ['settling'], 'settle_pending', this.d.now());
    let reason: string;
    let tx: Hex | null = null;
    try {
      const answer = await this.d.facilitator.settle(
        { x402Version: 2, paymentPayload, paymentRequirements },
        this.d.cfg.timeouts.settleMs,
      );
      // Receipt reads are left to the next tick's log query: pass a zero poll window.
      const out = await classifySettle(
        { ...this.d, cfg: { ...this.d.cfg, timeouts: { ...this.d.cfg.timeouts, receiptPollMs: 0 } } },
        targetOf(row),
        answer,
      );
      if (out.kind === 'rate_limited') reason = 'rate_limited';
      else {
        reason = out.kind === 'settled' ? 'settle_sent' : out.reason;
        tx = out.tx;
        if (out.kind === 'pending' && out.pause) {
          db.setPaused(true);
          this.d.log('facilitator_auth_or_credit', { status: answer.status });
        }
      }
    } catch (e) {
      reason = e instanceof FacilitatorUnreachable && e.timedOut ? 'timeout' : 'network_error';
    }
    db.note(row.request_id, tx ? { reject_reason: reason, settle_tx: tx } : { reject_reason: reason }, this.d.now());
    this.d.log('settle_retry', { requestId: row.request_id, reason });
  }
}

