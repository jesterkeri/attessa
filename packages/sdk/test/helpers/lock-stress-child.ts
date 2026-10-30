// Run by ledger.test.ts as a separate node process (INV-19 stress). argv: dataDir iterations killRate
// Enters the ledger lock `iterations` times. Inside, it claims a marker file and fails loudly if a live
// peer already holds it. It SIGKILLs itself at random: inside the critical section, and inside the
// lock code's own rename / rmdir / mkdir / unlink calls (so mid-break and mid-release too), and
// stalls inside a break so that peers act between a reading and its use.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const [dir, iterations, killRate] = process.argv.slice(2) as [string, string, string];
const rate = Number(killRate);
const { appendFileSync, linkSync, readFileSync, unlinkSync, writeFileSync } = fs;

const inBreak = (): boolean => (new Error().stack ?? '').includes('breakStaleLock');

/** Dies with probability `p` (ten times that inside a break, which is rarer and is where races live). */
function maybeDie(where: string, p = rate): void {
  const breaking = inBreak();
  if (Math.random() >= (breaking ? p * 10 : p)) return;
  appendFileSync(join(dir, 'kills.log'), `${where} ${breaking ? 'mid-break' : 'other'}\n`);
  process.kill(process.pid, 'SIGKILL');
}

/** Inside a break, often stalls up to 3 ms: widens the windows between a reading and acting on it. */
const nap = new Int32Array(new SharedArrayBuffer(4));
function maybeStall(): void {
  if (Math.random() < 0.3 && inBreak()) Atomics.wait(nap, 0, 0, Math.random() * 3);
}

for (const fn of ['renameSync', 'rmdirSync', 'mkdirSync', 'unlinkSync', 'readFileSync', 'readdirSync'] as const) {
  const real = fs[fn] as (...a: unknown[]) => unknown;
  const kills = fn !== 'readFileSync' && fn !== 'readdirSync';
  (fs as unknown as Record<string, unknown>)[fn] = (...a: unknown[]) => {
    maybeStall();
    if (kills) maybeDie(`before-${fn}`);
    const out = real(...a);
    maybeStall();
    if (kills) maybeDie(`after-${fn}`);
    return out;
  };
}
syncBuiltinESMExports();
const { Ledger } = await import('../../src/ledger.ts');
const ledger = new Ledger(dir);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const marker = join(dir, 'in-critical-section');
const mine = join(dir, `marker.${process.pid}`);
writeFileSync(mine, String(process.pid));
for (let i = 0; i < Number(iterations); i++) {
  ledger.withLock(() => {
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
    maybeDie('in-critical-section');
    unlinkSync(marker);
    return { result: undefined };
  });
  process.stdout.write('.');
}
