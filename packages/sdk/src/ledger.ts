import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, truncateSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Address, Hex } from 'viem';
import { RESERVED_STATES, SETTLED_STATES, TERMINAL_STATES, type EvidenceRow, type PendingEntry } from './types.ts';

// SPEC §7 pending ledger. Plain node built-ins only, so a second process can load this file
// directly (the INV-19 race test does).
//
// The cross-process lock is an SQLite write transaction (`BEGIN IMMEDIATE`) on an empty database
// file, used only as a mutex: the kernel's fcntl lock behind it is released when its holder exits or
// is killed, and a stopped holder simply makes others wait. No process ever judges a lock stale.

/** A `reserved` entry with no nonce older than this was never signed (SPEC §7). */
export const RESERVATION_TTL_MS = 10 * 60 * 1000;
/** How long a caller waits for a live holder before failing (it never takes the lock from one). */
const LOCK_TIMEOUT_MS = 30_000;
const SQLITE_NOTADB = 26;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isTerminal(e: PendingEntry): boolean {
  return TERMINAL_STATES.includes(e.state);
}

/**
 * Today's spend for `asset` (SPEC §7): every entry still holding a reservation, plus every settled
 * outcome created on the current UTC day.
 */
export function spendToday(entries: PendingEntry[], asset: Address, nowMs: number): bigint {
  const today = utcDay(nowMs);
  let total = 0n;
  for (const e of entries) {
    if (e.asset.toLowerCase() !== asset.toLowerCase()) continue;
    if (RESERVED_STATES.includes(e.state)) total += BigInt(e.amount);
    else if (SETTLED_STATES.includes(e.state) && utcDay(Number(e.createdAt)) === today) total += BigInt(e.amount);
  }
  return total;
}

export type ReserveResult = 'reserved' | 'over_daily_cap' | 'request_id_conflict' | { open: PendingEntry };

export class Ledger {
  readonly dir: string;
  readonly pendingPath: string;
  readonly evidencePath: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private lockDb: DatabaseSync | undefined;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.dir = dataDir;
    this.pendingPath = join(dataDir, 'pending.jsonl');
    this.evidencePath = join(dataDir, 'evidence.jsonl');
    this.lockPath = join(dataDir, 'pending.lock');
    this.now = now;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  /** Reads the ledger. Writes replace the file by rename, so a read never sees half a write. */
  list(): PendingEntry[] {
    let text: string;
    try {
      text = readFileSync(this.pendingPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as PendingEntry);
  }

  get(requestId: Hex): PendingEntry | undefined {
    return this.list().find((e) => e.requestId === requestId.toLowerCase());
  }

  /** Runs `fn` on the entries under the cross-process file lock and writes back what it returns. */
  withLock<T>(fn: (entries: PendingEntry[]) => { entries?: PendingEntry[]; result: T }): T {
    this.acquire();
    try {
      const { entries, result } = fn(this.list());
      if (entries) {
        // One record per requestId: `update` and `get` address an entry by it.
        const ids = new Set(entries.map((e) => e.requestId));
        if (ids.size !== entries.length) throw new Error('ledger write refused: two entries share one requestId');
        this.write(entries);
      }
      return result;
    } finally {
      this.release();
    }
  }

  /**
   * V6. Under the lock: drop stale unsigned reservations, then reserve `entry.amount` if today's
   * spend plus it stays within `dailyCap`. The reservation and the ledger entry are one record.
   * The V0 and requestId checks run again here, under the same lock, so two processes racing on one
   * input or one requestId can't both get past them (INV-14): with `resumeOpen` (payAndVerify without
   * `newRequest`), an open entry for the same `(originHash, requestHash)` is returned for V0 to resume,
   * and any entry already holding `entry.requestId` is a `request_id_conflict`. Nothing is signed in
   * either case.
   */
  reserve(
    entry: PendingEntry,
    dailyCap: bigint,
    opts: { resumeOpen?: boolean } = {},
  ): ReserveResult {
    return this.withLock<ReserveResult>((entries) => {
      const now = this.now();
      const kept = entries.filter(
        (e) => !(e.state === 'reserved' && e.nonce === null && now - Number(e.createdAt) > RESERVATION_TTL_MS),
      );
      if (opts.resumeOpen) {
        const open = kept.find((e) => e.originHash === entry.originHash && e.requestHash === entry.requestHash && !isTerminal(e));
        if (open) return { entries: kept, result: { open } };
      }
      if (kept.some((e) => e.requestId === entry.requestId.toLowerCase())) {
        return { entries: kept, result: 'request_id_conflict' };
      }
      if (spendToday(kept, entry.asset, now) + BigInt(entry.amount) > dailyCap) {
        return { entries: kept, result: 'over_daily_cap' };
      }
      return { entries: [...kept, entry], result: 'reserved' };
    });
  }

  update(requestId: Hex, patch: Partial<PendingEntry>): PendingEntry {
    return this.withLock((entries) => {
      const i = entries.findIndex((e) => e.requestId === requestId.toLowerCase());
      if (i < 0) throw new Error(`no ledger entry for ${requestId}`);
      const next = { ...entries[i]!, ...patch };
      const out = [...entries];
      out[i] = next;
      return { entries: out, result: next };
    });
  }

  /**
   * `update`, but only if the entry for `expected.requestId` is still exactly `expected`. A
   * reservation can be swept after 10 minutes and its requestId taken by another process; the
   * stalled owner must then not patch (V8: sign over) that other entry. Returns null if it changed.
   */
  updateIfUnchanged(expected: PendingEntry, patch: Partial<PendingEntry>): PendingEntry | null {
    return this.withLock<PendingEntry | null>((entries) => {
      const i = entries.findIndex((e) => sameEntry(e, expected));
      if (i < 0) return { result: null };
      const next = { ...entries[i]!, ...patch };
      const out = [...entries];
      out[i] = next;
      return { entries: out, result: next };
    });
  }

  /** Releases a reservation that was never signed (V7 failure), if the entry is still `expected`. */
  removeIfUnchanged(expected: PendingEntry): void {
    this.withLock((entries) => {
      const kept = entries.filter((e) => !sameEntry(e, expected));
      return kept.length === entries.length ? { result: undefined } : { entries: kept, result: undefined };
    });
  }

  /** Evidence is append-only. */
  appendEvidence(row: EvidenceRow): void {
    appendFileSync(this.evidencePath, JSON.stringify(row) + '\n', { mode: 0o600 });
  }

  readEvidence(): EvidenceRow[] {
    try {
      return readFileSync(this.evidencePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as EvidenceRow);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  private write(entries: PendingEntry[]): void {
    const tmp = `${this.pendingPath}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, entries.map((e) => JSON.stringify(e) + '\n').join(''));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.pendingPath);
  }

  private acquire(): void {
    if (!this.lockDb) {
      this.lockDb = new DatabaseSync(this.lockPath);
      this.lockDb.exec(`PRAGMA busy_timeout = ${LOCK_TIMEOUT_MS}`);
    }
    try {
      this.lockDb.exec('BEGIN IMMEDIATE');
    } catch (e) {
      // A pending.lock written by the earlier pid-file lock is not a database. Emptying it in place
      // (never unlinking, so every process keeps locking the same inode) makes it a valid one.
      if ((e as { errcode?: number }).errcode !== SQLITE_NOTADB) {
        throw new Error(`ledger lock ${this.lockPath} not acquired: ${(e as Error).message}`, { cause: e });
      }
      truncateSync(this.lockPath, 0);
      this.lockDb.exec('BEGIN IMMEDIATE');
    }
  }

  private release(): void {
    this.lockDb!.exec('ROLLBACK');
  }
}

/** Same entry, field by field (values are strings or null). */
function sameEntry(a: PendingEntry, b: PendingEntry): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof PendingEntry>;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}
