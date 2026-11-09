import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Durable, append-only record of every paid authorization that may have reached a service (SPEC §5, §11 C5.3), one JSON
 * object per line, each line fsynced before the call returns. Format (v1):
 *   {"v":1,"kind":"intent","id":<uuid>,"capability":<id>,"payer":<0x..>,"cap":<atomic USDC>,"nonce":null,"timestamp":<iso>}
 *   {"v":1,"kind":"nonce","id":<uuid>,"nonce":<0x..>,"timestamp":<iso>}       the signed authorization's nonce, before it is sent
 *   {"v":1,"kind":"outcome","id":<uuid>,"status":"responded"|"uncertain","timestamp":<iso>}
 * An intent is written before the paid request is sent. It counts as spent at its `cap` whatever happens next,
 * `uncertain` included (the paid request produced no response, so the money may have moved). An intent with no outcome
 * line (a crash mid-flight) counts the same. The file is never rewritten or truncated here.
 */
export interface LedgerLine {
  v: 1;
  kind: 'intent' | 'nonce' | 'outcome';
  id: string;
  timestamp: string;
  capability?: string;
  payer?: string;
  cap?: string;
  nonce?: string | null;
  status?: 'responded' | 'uncertain';
}

export function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // a directory that cannot be opened for sync (some platforms) is not a reason to lose the write
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Write `data` to `path` through a temp file, fsynced, then renamed, then the directory fsynced. */
export function durableReplace(path: string, data: string, mode = 0o640): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

export class BuyIntentLedger {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  /** Append one line and fsync it (and the directory, when the file is new). Throws if it is not durable. */
  append(line: LedgerLine): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    let fresh = false;
    try {
      readFileSync(this.path);
    } catch {
      fresh = true;
    }
    const fd = openSync(this.path, 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(line)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (fresh) fsyncDir(dir);
  }

  /** All lines. A missing file is empty; an unreadable file or a malformed line throws (a damaged record is never read as no spend). */
  read(): LedgerLine[] {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: LedgerLine[] = [];
    for (const raw of text.split('\n')) {
      if (raw === '') continue;
      const l = JSON.parse(raw) as LedgerLine;
      if (l?.v !== 1 || (l.kind !== 'intent' && l.kind !== 'nonce' && l.kind !== 'outcome') || typeof l.id !== 'string' || typeof l.timestamp !== 'string') throw new Error('buy ledger: malformed line');
      if (l.kind === 'intent' && (typeof l.cap !== 'string' || !/^(0|[1-9][0-9]*)$/.test(l.cap))) throw new Error('buy ledger: malformed intent');
      out.push(l);
    }
    return out;
  }

  /** Atomic USDC committed on UTC `day` (YYYY-MM-DD): every intent, uncertain and unfinished ones included. */
  spentOn(day: string): bigint {
    let sum = 0n;
    for (const l of this.read()) if (l.kind === 'intent' && l.timestamp.slice(0, 10) === day) sum += BigInt(l.cap!);
    return sum;
  }
}
