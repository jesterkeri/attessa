import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger.ts';
import type { PendingEntry } from '../src/types.ts';

// Adversary pass on T20, round 5 (SPEC §7 "under the same file lock", INVARIANTS.md INV-19
// "concurrent processes share one lock"). Real processes, no mock of the lock.

let dir: string | undefined;
afterEach(() => {
  if (dir) {
    try {
      chmodSync(join(dir, 'pending.lock'), 0o600);
    } catch {
      // no lock file
    }
    rmSync(dir, { recursive: true, force: true });
  }
  dir = undefined;
});

const ASSET = '0x1111111111111111111111111111111111111111';
function entry(id: string): PendingEntry {
  return {
    v: '1', requestId: `0x${id.repeat(32)}`, origin: 'https://risk.example', originHash: `0x${'11'.repeat(32)}`, method: 'POST',
    pathAndQuery: '/v1/evaluate', requestHash: `0x${id.repeat(32)}`, asset: ASSET, amount: '20000',
    payTo: '0x2222222222222222222222222222222222222222', payer: '0x3333333333333333333333333333333333333333', nonce: null,
    signedAtChain: null, signedAtBlock: null, validAfter: null, validBefore: null, agentId: '7', expectedSigner: null,
    state: 'reserved', code: null, settlementTx: null, createdAt: String(Date.now()),
  } as PendingEntry;
}
const ids = (d: string): string[] =>
  existsSync(join(d, 'pending.jsonl'))
    ? readFileSync(join(d, 'pending.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as PendingEntry).requestId)
    : [];

describe('adversary T20 r5: the lock', () => {
  // pending.lock exists but this user cannot write it: it was created by `sudo attessa ...` (root,
  // 0644) or restored read-only from a backup. SQLite then opens the lock database read-only, and
  // `BEGIN IMMEDIATE` on a read-only connection succeeds without excluding anyone. Two processes are
  // inside the critical section at once: the holder writes back its old snapshot and the other
  // process's V6 reservation is gone (INV-19). Either the second process must wait, or the ledger
  // must refuse with an error; it must never enter while the holder is inside.
  it('a pending.lock this user cannot write never lets two processes in at once', async () => {
    dir = mkdtempSync(join(tmpdir(), 'attessa-ledger-'));
    const d = dir;
    writeFileSync(join(d, 'pending.lock'), '');
    chmodSync(join(d, 'pending.lock'), 0o444);
    const marker = join(d, 'inside');
    const ledgerSrc = fileURLToPath(new URL('../src/ledger.ts', import.meta.url));
    const holderCode = `
      import { writeFileSync, unlinkSync } from 'node:fs';
      const { Ledger } = await import(${JSON.stringify(ledgerSrc)});
      const [dir, marker, e] = process.argv.slice(1);
      try {
        new Ledger(dir).withLock((entries) => {
          writeFileSync(marker, String(process.pid));
          process.stdout.write('in');
          const t = Date.now();
          while (Date.now() - t < 1500);
          unlinkSync(marker);
          return { entries: [...entries, JSON.parse(e)], result: undefined };
        });
        process.stdout.write('|ok');
      } catch (err) {
        process.stdout.write('|threw ' + err.message);
      }`;
    const holder = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', holderCode, d, marker, JSON.stringify(entry('0a'))], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    holder.stdout.on('data', (b: Buffer) => (out += b.toString()));
    const exited = new Promise((r) => holder.once('exit', r));
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on('data', () => out.includes('in') && resolve());
      holder.once('exit', () => (out.includes('in') ? resolve() : reject(new Error(`holder never entered: ${out}`))));
    });

    let enteredWhileHeld = false;
    let got: string;
    try {
      new Ledger(d).withLock((entries) => {
        enteredWhileHeld = existsSync(marker);
        return { entries: [...entries, entry('0b')], result: undefined };
      });
      got = 'reserved';
    } catch (e) {
      got = `threw: ${(e as Error).message}`;
    }
    await exited;
    const lost = got === 'reserved' && !ids(d).includes(entry('0b').requestId);
    expect({ enteredWhileHeld, reservationLost: lost }).toEqual({ enteredWhileHeld: false, reservationLost: false });
  }, 60_000);
});
