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
  live: ReadonlySet<string>;
  log: (event: string, fields: Record<string, unknown>) => void;
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  private readonly d: ReconcilerDeps;
  constructor(d: ReconcilerDeps) {
    this.d = d;
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

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** One pass. Concurrent calls share the pass in flight. */
  tick(): Promise<void> {
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async pass(): Promise<void> {
    const { db } = this.d;
    for (const row of db.inStates(['settling', 'settle_pending'])) {
      try {
        await this.reconcileSettlement(row);
      } catch (e) {
        this.d.log('reconcile_error', { requestId: row.request_id, error: (e as Error).message });
      }
    }
    const now = this.d.now();
    for (const row of db.inStates(['settled'])) {
      if (!this.d.live.has(row.request_id) && now - row.updated_at > DELIVERY_GRACE_S) {
        db.transition(row.request_id, ['settled'], 'delivery_failed', now);
      }
    }
    db.applyRetention(now);
  }

  /** SPEC §6.3 steps 1–5 for one `settling` / `settle_pending` row. Only chain evidence terminalizes. */
  private async reconcileSettlement(row: CallRow): Promise<void> {
    const { chain, db } = this.d;
    const t = targetOf(row);
    const fromBlock = BigInt(row.created_block);
    // 1–2. AuthorizationUsed(payer, nonce) from the row's asset, then the same tx must carry the Transfer.
    const used = await chain.getLogs(t.asset, authorizationTopics('AuthorizationUsed', t.payer, t.nonce), fromBlock);
    const usedLog = used.find((l) => isAuthorizationUsed(l, t));
    if (usedLog) {
      const receipt = await chain.receipt(usedLog.transactionHash);
      if (!receipt) return; // log seen, receipt not served yet: next tick
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
      return;
    }
    // 3. AuthorizationCanceled(payer, nonce).
    const cancelled = await chain.getLogs(t.asset, authorizationTopics('AuthorizationCanceled', t.payer, t.nonce), fromBlock);
    if (cancelled.length > 0) {
      db.transition(row.request_id, ['settling', 'settle_pending'], 'settle_failed', this.d.now(), { reject_reason: 'cancelled' });
      this.d.log('settle_failed', { requestId: row.request_id, reason: 'cancelled' });
      return;
    }
    // 4. Expiry, judged at a block past validBefore + 5.
    const head = await chain.latestBlock();
    if (head.timestamp > BigInt(row.valid_before + EXPIRY_MARGIN_S)) {
      const isUsed = await chain.authorizationState(t.asset, t.payer, t.nonce, head.number);
      if (!isUsed) {
        db.transition(row.request_id, ['settling', 'settle_pending'], 'settle_failed', this.d.now(), { reject_reason: 'expired' });
        this.d.log('settle_failed', { requestId: row.request_id, reason: 'expired' });
      }
      return; // used but the log query is behind: next tick
    }
    // 5. Retry from the stored payload. The answer is recorded, never acted on as a terminal outcome.
    if (db.isPaused() || this.d.sending.has(row.request_id) || !row.payment_payload || !row.requirements) return;
    if (row.state === 'settling' && this.d.now() - row.updated_at <= SETTLING_RESEND_AFTER_S) return;
    await this.resend(row);
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

