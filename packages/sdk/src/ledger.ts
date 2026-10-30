import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { RESERVED_STATES, SETTLED_STATES, TERMINAL_STATES, type EvidenceRow, type PendingEntry } from './types.ts';

// SPEC §7 pending ledger. Plain node built-ins only, so a second process can load this file
// directly (the INV-19 race test does).

/** A `reserved` entry with no nonce older than this was never signed (SPEC §7). */
export const RESERVATION_TTL_MS = 10 * 60 * 1000;
/** A lock file older than this belongs to a process that died inside the critical section. */
const STALE_LOCK_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
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
      try {
        unlinkSync(this.lockPath);
      } catch {
        // already gone: a peer judged it stale; nothing to release
      }
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

  /** Releases a reservation that was never signed (V7 failure). */
  remove(requestId: Hex): void {
    this.withLock((entries) => ({
      entries: entries.filter((e) => e.requestId !== requestId.toLowerCase()),
      result: undefined,
    }));
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
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      this.breakStaleLock();
      if (Date.now() > deadline) throw new Error(`ledger lock ${this.lockPath} held for over ${LOCK_TIMEOUT_MS} ms`);
      sleepSync(2 + Math.floor(Math.random() * 8));
    }
  }

  private breakStaleLock(): void {
    try {
      const age = Date.now() - statSync(this.lockPath).mtimeMs;
      const pid = Number(readFileSync(this.lockPath, 'utf8'));
      const dead = Number.isSafeInteger(pid) && pid > 0 && !pidAlive(pid);
      if (age > STALE_LOCK_MS || dead) unlinkSync(this.lockPath);
    } catch {
      // the holder released it between our checks
    }
  }
}
