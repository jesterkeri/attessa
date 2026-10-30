import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Adversary pass on T20, round 6 (SPEC §7 "under the same file lock", INVARIANTS.md INV-19
// "concurrent processes share one lock"). Real processes, no mock of the lock.

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const ledgerSrc = fileURLToPath(new URL('../src/ledger.ts', import.meta.url));
// One process: wait for the shared start time, set the umask, enter the lock once, claim a marker
// inside it (EEXIST means a peer is inside too), stay 50 ms, append one entry. Prints `ok`, `V`
// (overlap) or `E <message>` (a refusal, which is acceptable).
const childCode = `
  import { writeFileSync, unlinkSync } from 'node:fs';
  const { Ledger } = await import(${JSON.stringify(ledgerSrc)});
  const [dir, go, umask, tag] = process.argv.slice(1);
  const l = new Ledger(dir);
  while (Date.now() < Number(go));
  process.umask(Number(umask));
  try {
    l.withLock((entries) => {
      const marker = dir + '/inside';
      try { writeFileSync(marker, tag, { flag: 'wx' }); } catch { process.stdout.write('V'); }
      const t = Date.now();
      while (Date.now() - t < 50);
      try { unlinkSync(marker); } catch {}
      return { entries: [...entries, { requestId: '0x' + tag.padStart(64, '0') }], result: undefined };
    });
    process.stdout.write('ok');
  } catch (e) {
    process.stdout.write('E ' + e.message);
  }`;

function runChild(d: string, go: number, umask: number, tag: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', childCode, d, String(go), String(umask), tag], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (b: Buffer) => (out += b.toString()));
    p.on('exit', () => resolve(out));
  });
}

describe('adversary T20 r6: the lock', () => {
  // ensureWritableLock() runs before the lock database is opened. When pending.lock does not exist
  // yet, every process passes the check (ENOENT), then the first one's SQLite creates the file. Under
  // a umask that drops owner write (0277), that file is 0400: the creator holds a read-write handle,
  // and every other process's SQLite falls back to a read-only open, where BEGIN IMMEDIATE excludes
  // no one (the round-5 defect again). Several processes are inside at once and their writes are lost.
  it('processes racing to create pending.lock under umask 0277 never enter the lock together', async () => {
    dir = mkdtempSync(join(tmpdir(), 'attessa-ledger-'));
    const d = dir;
    const go = Date.now() + 1500;
    const n = 6;
    const outs = await Promise.all(Array.from({ length: n }, (_, i) => runChild(d, go, 0o277, (i + 1).toString(16))));
    const overlaps = outs.filter((o) => o.includes('V')).length;
    const ok = outs.filter((o) => o.endsWith('ok')).length;
    const stored = existsSync(join(d, 'pending.jsonl')) ? readFileSync(join(d, 'pending.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
    // Refusing is fine; entering together, or a returned write that is not in the file, is not.
    expect({ overlaps, lostWrites: ok - stored }).toEqual({ overlaps: 0, lostWrites: 0 });
  }, 60_000);
});
