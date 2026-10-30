import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * SPEC §5 input-read budget guard. Seller-host keeps a daily (UTC) counter of buy spend. A paid read is
 * allowed only while today's spend, including that read, stays within the gateway's settled revenue for
 * the day + 1 USDC; otherwise reads go to Forno (`source:"forno"`), the state file says `tripped`, and
 * `health.sh` alerts on it. Amounts are atomic units of a 6-decimal stablecoin.
 */

export const ONE_USDC = 1_000_000n;

export interface RevenueSource {
  /** Settled revenue since `dayStartSec` (unix seconds), in atomic units. */
  settledSince(dayStartSec: number): bigint;
}

export interface GuardState {
  day: string;
  spentAtomic: string;
  tripped: boolean;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function dayStartSec(now: Date): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
}

export class BuySpendGuard {
  private readonly statePath: string;
  private readonly revenue: RevenueSource;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  constructor(statePath: string, revenue: RevenueSource, log: (event: string, fields?: Record<string, unknown>) => void = () => {}) {
    this.statePath = statePath;
    this.revenue = revenue;
    this.log = log;
  }

  /** Today's state. A missing or unreadable file, or yesterday's, starts the day at zero. */
  state(now: Date): GuardState {
    const day = utcDay(now);
    try {
      const s = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<GuardState>;
      if (s.day === day && typeof s.spentAtomic === 'string' && /^(0|[1-9][0-9]*)$/.test(s.spentAtomic)) {
        return { day, spentAtomic: s.spentAtomic, tripped: s.tripped === true };
      }
    } catch {
      // first run of the day
    }
    return { day, spentAtomic: '0', tripped: false };
  }

  private save(s: GuardState): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s)}\n`, { mode: 0o640 });
    renameSync(tmp, this.statePath);
  }

  /** True when a paid read of `cost` keeps today's spend within settled revenue + 1 USDC. */
  allow(cost: bigint, now: Date): boolean {
    const s = this.state(now);
    const budget = this.revenue.settledSince(dayStartSec(now)) + ONE_USDC;
    const ok = BigInt(s.spentAtomic) + cost <= budget;
    if (!ok && !s.tripped) {
      this.save({ ...s, tripped: true });
      this.log('buy_budget_tripped', { day: s.day, spentAtomic: s.spentAtomic, budgetAtomic: budget.toString() });
    }
    return ok;
  }

  record(cost: bigint, now: Date): void {
    const s = this.state(now);
    this.save({ ...s, spentAtomic: (BigInt(s.spentAtomic) + cost).toString() });
  }
}

const SETTLED_STATES = ['settled', 'delivered', 'delivery_failed'];

/**
 * Reads the gateway's SQLite `calls` table (SPEC §6.4) read-only. Any failure counts as zero revenue, so
 * the guard trips sooner, never later.
 */
export class GatewayDbRevenue implements RevenueSource {
  private readonly dbPath: string;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  constructor(dbPath: string, log: (event: string, fields?: Record<string, unknown>) => void = () => {}) {
    this.dbPath = dbPath;
    this.log = log;
  }

  settledSince(dayStartSec: number): bigint {
    let db: Database.Database | null = null;
    try {
      db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      const rows = db
        .prepare(`SELECT amount FROM calls WHERE updated_at >= ? AND state IN (${SETTLED_STATES.map(() => '?').join(',')})`)
        .all(dayStartSec, ...SETTLED_STATES) as Array<{ amount: string }>;
      let sum = 0n;
      for (const r of rows) if (/^(0|[1-9][0-9]*)$/.test(r.amount)) sum += BigInt(r.amount);
      return sum;
    } catch (e) {
      this.log('revenue_unreadable', { reason: (e as Error).message });
      return 0n;
    } finally {
      db?.close();
    }
  }
}
