// Run by ledger.test.ts as a separate node process (INV-19 stress). argv: dataDir iterations killRate stopRate
// Enters the ledger lock `iterations` times and appends one entry each time. Inside, it claims a
// marker file and fails loudly if a live peer already holds it. At random it SIGKILLs itself inside
// the critical section or mid-write, and SIGSTOPs itself inside the critical section (after printing
// `S`, so the parent can SIGCONT or SIGKILL it later). After a stop it checks that nobody entered.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import type { PendingEntry } from '../../src/types.ts';

const [dir, iterations, killRate, stopRate] = process.argv.slice(2) as [string, string, string, string];
const { appendFileSync, linkSync, readFileSync, unlinkSync, writeFileSync } = fs;

function maybeDie(where: string): void {
  if (Math.random() >= Number(killRate)) return;
  appendFileSync(join(dir, 'kills.log'), `${where}\n`);
  process.kill(process.pid, 'SIGKILL');
}

// Kills mid-write too: before and after the ledger's own open / rename.
for (const fn of ['openSync', 'renameSync'] as const) {
  const real = fs[fn] as (...a: unknown[]) => unknown;
  (fs as unknown as Record<string, unknown>)[fn] = (...a: unknown[]) => {
    maybeDie(`before-${fn}`);
    const out = real(...a);
    maybeDie(`after-${fn}`);
    return out;
  };
}
syncBuiltinESMExports();
const { Ledger } = await import('../../src/ledger.ts');
const ledger = new Ledger(dir);

/** Running or stopped; a killed peer the parent hasn't reaped yet is a zombie, not alive (Linux). */
function alive(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]![0] !== 'Z';
  } catch {
    return false;
  }
}

const nap = new Int32Array(new SharedArrayBuffer(4));
const marker = join(dir, 'in-critical-section');
const mine = join(dir, `marker.${process.pid}`);
writeFileSync(mine, String(process.pid));
for (let i = 0; i < Number(iterations); i++) {
  ledger.withLock((entries) => {
    for (;;) {
      try {
        linkSync(mine, marker); // exclusive, and the pid is in it from the first instant
        break;
      } catch {
        // A marker is left only by a peer that was killed inside the critical section.
        const pid = Number(readFileSync(marker, 'utf8'));
        if (alive(pid)) {
          appendFileSync(join(dir, 'violations.log'), `${process.pid} entered while ${pid} was inside\n`);
          process.exit(3);
        }
        unlinkSync(marker);
      }
    }
    Atomics.wait(nap, 0, 0, Math.random() * 2); // stay inside long enough for an overlap to show
    if (Math.random() < Number(stopRate)) {
      appendFileSync(join(dir, 'stops.log'), `${process.pid}\n`);
      process.stdout.write('S');
      process.kill(process.pid, 'SIGSTOP');
      if (readFileSync(marker, 'utf8') !== String(process.pid)) {
        appendFileSync(join(dir, 'violations.log'), `${process.pid} was stopped inside and a peer entered\n`);
        process.exit(3);
      }
    }
    maybeDie('in-critical-section');
    unlinkSync(marker);
    const e = { requestId: `0x${randomBytes(32).toString('hex')}` } as PendingEntry;
    return { entries: [...entries, e], result: undefined };
  });
  process.stdout.write('.');
}
