import Database from 'better-sqlite3';

/** SPEC §6.4, verbatim. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  request_id        TEXT PRIMARY KEY,
  payer             TEXT NOT NULL,
  asset             TEXT NOT NULL,
  pay_to            TEXT NOT NULL,
  amount            TEXT NOT NULL,
  auth_nonce        TEXT NOT NULL,
  valid_before      INTEGER NOT NULL,
  request_hash      TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('payment_verified','executing','exec_failed','proof_rejected','too_late','settling','settle_pending','settled','settle_failed','delivered','delivery_failed')),
  reject_reason     TEXT,
  response          BLOB,
  proof_header      TEXT,
  payment_payload   TEXT,
  requirements      TEXT,
  settle_tx         TEXT,
  created_block     INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  result_expires_at INTEGER,
  UNIQUE (asset, payer, auth_nonce)
);
CREATE INDEX IF NOT EXISTS calls_payer_created ON calls(payer, created_at);
CREATE INDEX IF NOT EXISTS calls_open ON calls(state) WHERE state IN ('payment_verified','executing','settling','settle_pending','settled');
CREATE TABLE IF NOT EXISTS gateway_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export type CallState =
  | 'payment_verified'
  | 'executing'
  | 'exec_failed'
  | 'proof_rejected'
  | 'too_late'
  | 'settling'
  | 'settle_pending'
  | 'settled'
  | 'settle_failed'
  | 'delivered'
  | 'delivery_failed';

export const TERMINAL_STATES: readonly CallState[] = [
  'delivered',
  'delivery_failed',
  'exec_failed',
  'proof_rejected',
  'too_late',
  'settle_failed',
];

/** States that end a paid call without settling (SPEC §6.1 per-payer limit). */
export const UNSETTLED_STATES: readonly CallState[] = ['exec_failed', 'proof_rejected', 'too_late', 'settle_failed'];

export interface CallRow {
  request_id: string;
  payer: string;
  asset: string;
  pay_to: string;
  amount: string;
  auth_nonce: string;
  valid_before: number;
  request_hash: string;
  state: CallState;
  reject_reason: string | null;
  response: Buffer | null;
  proof_header: string | null;
  payment_payload: string | null;
  requirements: string | null;
  settle_tx: string | null;
  created_block: number;
  created_at: number;
  updated_at: number;
  result_expires_at: number | null;
}

export type NewCall = Pick<
  CallRow,
  'request_id' | 'payer' | 'asset' | 'pay_to' | 'amount' | 'auth_nonce' | 'valid_before' | 'request_hash' | 'created_block'
>;

/** Results are kept 24 h after settle (SPEC §6.4). */
export const RESULT_RETENTION_S = 24 * 3600;
/** Rows are kept until 2026-12-31, then deleted (SPEC §6.4). */
export const ROW_DELETE_AFTER = Date.UTC(2027, 0, 1) / 1000;

export class CallStore {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = FULL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  isPaused(): boolean {
    const r = this.db.prepare(`SELECT value FROM gateway_state WHERE key = 'paused'`).get() as { value: string } | undefined;
    return r?.value === 'true';
  }

  setPaused(paused: boolean): void {
    this.db
      .prepare(`INSERT INTO gateway_state (key, value) VALUES ('paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(paused ? 'true' : 'false');
  }

  byRequestId(requestId: string): CallRow | undefined {
    return this.db.prepare(`SELECT * FROM calls WHERE request_id = ?`).get(requestId) as CallRow | undefined;
  }

  byPayment(asset: string, payer: string, nonce: string): CallRow | undefined {
    return this.db
      .prepare(`SELECT * FROM calls WHERE asset = ? AND payer = ? AND auth_nonce = ?`)
      .get(asset, payer, nonce) as CallRow | undefined;
  }

  insertVerified(c: NewCall, now: number): void {
    this.db
      .prepare(
        `INSERT INTO calls (request_id, payer, asset, pay_to, amount, auth_nonce, valid_before, request_hash, state, created_block, created_at, updated_at)
         VALUES (@request_id, @payer, @asset, @pay_to, @amount, @auth_nonce, @valid_before, @request_hash, 'payment_verified', @created_block, @now, @now)`,
      )
      .run({ ...c, now });
  }

  /**
   * Moves a row to `to` only if it is currently in one of `from` (a guarded transition), and NULLs
   * `payment_payload` when `to` is terminal (SPEC §6.3). Returns whether the row moved.
   */
  transition(
    requestId: string,
    from: readonly CallState[],
    to: CallState,
    now: number,
    set: { reject_reason?: string | null; settle_tx?: string | null; result_expires_at?: number | null } = {},
  ): boolean {
    const cols = ['state = @to', 'updated_at = @now'];
    if (TERMINAL_STATES.includes(to)) cols.push('payment_payload = NULL');
    if ('reject_reason' in set) cols.push('reject_reason = @reject_reason');
    if ('settle_tx' in set) cols.push('settle_tx = @settle_tx');
    if ('result_expires_at' in set) cols.push('result_expires_at = @result_expires_at');
    const placeholders = from.map((_, i) => `@f${i}`).join(',');
    const params: Record<string, unknown> = { request_id: requestId, to, now, ...set };
    from.forEach((s, i) => (params[`f${i}`] = s));
    const r = this.db
      .prepare(`UPDATE calls SET ${cols.join(', ')} WHERE request_id = @request_id AND state IN (${placeholders})`)
      .run(params);
    return r.changes === 1;
  }

  /** SPEC §6.2 step 11: one statement stores the response, proof header, payment payload and requirements, and enters `settling`. */
  persistForSettle(
    requestId: string,
    v: { response: Buffer; proof_header: string; payment_payload: string; requirements: string },
    now: number,
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE calls SET state = 'settling', response = @response, proof_header = @proof_header, payment_payload = @payment_payload,
           requirements = @requirements, updated_at = @now WHERE request_id = @request_id AND state = 'executing'`,
      )
      .run({ request_id: requestId, now, ...v });
    return r.changes === 1;
  }

  /**
   * Records a non-terminal settle answer (reason, tx) without changing state. Only while the row is still
   * `settling` / `settle_pending`: a re-send answered after chain evidence resolved the row never
   * overwrites the recorded outcome (SPEC §6.3 step 5). Returns whether the row was updated.
   */
  note(requestId: string, set: { reject_reason?: string | null; settle_tx?: string | null }, now: number): boolean {
    const cols = ['updated_at = @now'];
    if ('reject_reason' in set) cols.push('reject_reason = @reject_reason');
    if ('settle_tx' in set) cols.push('settle_tx = @settle_tx');
    const r = this.db
      .prepare(`UPDATE calls SET ${cols.join(', ')} WHERE request_id = @request_id AND state IN ('settling','settle_pending')`)
      .run({ request_id: requestId, now, ...set });
    return r.changes === 1;
  }

  countUnsettledSince(payer: string, since: number): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM calls WHERE payer = ? AND created_at > ? AND state IN (${UNSETTLED_STATES.map(() => '?').join(',')})`,
      )
      .get(payer, since, ...UNSETTLED_STATES) as { n: number };
    return r.n;
  }

  inStates(states: readonly CallState[]): CallRow[] {
    return this.db
      .prepare(`SELECT * FROM calls WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at`)
      .all(...states) as CallRow[];
  }

  /** SPEC §6.4 retention: `response` → NULL at `result_expires_at`; rows deleted after 2026-12-31. */
  applyRetention(now: number): void {
    this.db.prepare(`UPDATE calls SET response = NULL WHERE response IS NOT NULL AND result_expires_at IS NOT NULL AND result_expires_at <= ?`).run(now);
    // Responses of rows that never settled are never served; drop them once terminal.
    this.db
      .prepare(`UPDATE calls SET response = NULL WHERE response IS NOT NULL AND state IN ('exec_failed','proof_rejected','too_late','settle_failed')`)
      .run();
    if (now >= ROW_DELETE_AFTER) this.db.prepare(`DELETE FROM calls`).run();
  }

  countsByState(): Record<string, number> {
    const rows = this.db.prepare(`SELECT state, COUNT(*) AS n FROM calls GROUP BY state`).all() as Array<{ state: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  since(createdAt: number): CallRow[] {
    return this.db.prepare(`SELECT * FROM calls WHERE created_at >= ? ORDER BY created_at, request_id`).all(createdAt) as CallRow[];
  }
}
