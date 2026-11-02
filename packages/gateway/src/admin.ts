import type { CallRow, CallStore } from './db.ts';
import type { Facilitator } from './facilitator.ts';

/**
 * `attessa gateway pause | resume | status | export` (SPEC §6.6, §6.4). They act on the gateway's SQLite
 * file; the running gateway reads `paused` on every request, so a pause takes effect at once.
 */

export function pause(db: CallStore): string {
  db.setPaused(true);
  return 'Gateway paused: new calls get 503 gateway_paused; open payments keep reconciling.';
}

export type ResumeResult = { ok: true; message: string } | { ok: false; message: string };

/** SPEC §6.6: `resume` first calls `/supported` with the API key and refuses on 401/402. */
export async function resume(db: CallStore, facilitator: Facilitator, timeoutMs = 10_000): Promise<ResumeResult> {
  let status: number;
  try {
    status = (await facilitator.supported(timeoutMs)).status;
  } catch {
    return { ok: false, message: 'Not resumed: the facilitator did not answer /supported.' };
  }
  if (status === 401 || status === 402) {
    return { ok: false, message: `Not resumed: the facilitator refused the API key or credit (HTTP ${status}).` };
  }
  if (status < 200 || status >= 300) return { ok: false, message: `Not resumed: the facilitator answered /supported with HTTP ${status}.` };
  db.setPaused(false);
  return { ok: true, message: 'Gateway resumed.' };
}

export function status(db: CallStore): { paused: boolean; states: Record<string, number> } {
  return { paused: db.isPaused(), states: db.countsByState() };
}

/** States whose proof passed every §6.2 step-9 check. */
const PROOF_VERIFIED = new Set(['too_late', 'settling', 'settle_pending', 'settled', 'settle_failed', 'delivered', 'delivery_failed']);

export const EXPORT_COLUMNS = ['request_id', 'payer', 'pay_to', 'asset', 'amount', 'settle_tx', 'state', 'proof_verified', 'created_at'] as const;

function exportRow(r: CallRow): Record<(typeof EXPORT_COLUMNS)[number], string> {
  return {
    request_id: r.request_id,
    payer: r.payer,
    pay_to: r.pay_to,
    asset: r.asset,
    amount: r.amount,
    settle_tx: r.settle_tx ?? '',
    state: r.state,
    proof_verified: PROOF_VERIFIED.has(r.state) ? 'true' : 'false',
    created_at: new Date(r.created_at * 1000).toISOString(),
  };
}

/** SPEC §6.4 export. `since` is an ISO date (`2026-11-01`) or date-time. */
export function exportRows(db: CallStore, since: string, format: 'csv' | 'jsonl'): string {
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) throw new Error(`--since: not a date: ${since}`);
  const rows = db.since(Math.floor(ms / 1000)).map(exportRow);
  if (format === 'jsonl') return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  const lines = [EXPORT_COLUMNS.join(',')];
  // Every exported value is hex, decimal, a state name or an ISO date: none needs CSV quoting.
  for (const r of rows) lines.push(EXPORT_COLUMNS.map((c) => r[c]).join(','));
  return lines.join('\n') + '\n';
}

