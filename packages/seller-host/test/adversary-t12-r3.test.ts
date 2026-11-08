import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Adversary pass on T12 (4bf3224): exit status after cleanup, swallowed terminate failures, and cleanup
// finding an enclave by CID that this run did not start.
const spike = fileURLToPath(new URL('../../../scripts/t12-spike.sh', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function fake(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

// State file STATE holds one "<EnclaveID> <EnclaveCID>" per running enclave. Knobs (env):
//   DESCRIBE_FAIL_FROM=n    describe-enclaves exits 1 from its n-th call on (1 = preflight, 2-4 = snapshots before runs 18/16/17, 5 = final report, 6 = cleanup).
//   Edited after the t12-spike.sh fix: the knob was 3 (cleanup) before the per-run snapshots existed; only that number and this comment changed.
//   TERMINATE_FAILS=1       terminate-enclave exits 1 and leaves the enclave running
//   START_THEN_FAIL_CID=c   run-enclave for CID c starts the enclave and then exits 1
//   FOREIGN_CID=c           a seller started by someone else takes CID c right before our run-enclave c, which then fails
function runSpike(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'attessa-adv-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const state = join(dir, 'enclaves');
  const log = join(dir, 'calls.log');
  writeFileSync(state, '');
  fake(bin, 'uname', 'echo aarch64');
  fake(bin, 'docker', 'echo "docker $*" >> "$LOG"');
  fake(bin, 'socat', 'echo "socat $*" >> "$LOG"; echo $$ > "$SOCATPID"; exec sleep 60');
  fake(bin, 'node', 'echo "node $*" >> "$LOG"');
  fake(
    bin,
    'nitro-cli',
    `echo "nitro-cli $*" >> "$LOG"
case "$1" in
  describe-enclaves)
    n=$(cat "$STATE.calls" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$STATE.calls"
    if [ -e "$STATE.slow" ]; then sleep 2; fi
    if [ -n "\${DESCRIBE_FAIL_FROM:-}" ] && [ "$n" -ge "$DESCRIBE_FAIL_FROM" ]; then exit 1; fi
    jq -R -s -c 'split("\\n") | map(select(length>0) | split(" ")) | map({EnclaveID: .[0], EnclaveCID: (.[1]|tonumber), NumberOfCPUs: 1, MemoryMiB: 1024, State: "RUNNING"})' "$STATE" ;;
  build-enclave) echo '{"Measurements":{"PCR0":"00"}}' ;;
  run-enclave)
    while [ $# -gt 0 ]; do [ "$1" = --enclave-cid ] && cid=$2; shift; done
    if [ "$cid" = "\${FOREIGN_CID:-}" ]; then echo "i-seller-$cid $cid" >> "$STATE"; exit 1; fi
    echo "i-fake-$cid $cid" >> "$STATE"
    [ "$cid" != "\${START_THEN_FAIL_CID:-}" ] || exit 1
    echo "{\\"EnclaveID\\":\\"i-fake-$cid\\",\\"EnclaveCID\\":$cid,\\"NumberOfCPUs\\":1,\\"MemoryMiB\\":1024}" ;;
  terminate-enclave)
    [ -z "\${TERMINATE_FAILS:-}" ] || exit 1
    grep -v "^$3 " "$STATE" > "$STATE.new" || true; mv "$STATE.new" "$STATE" ;;
esac`,
  );
  const cwd = join(dir, 'work');
  mkdirSync(cwd);
  const r = spawnSync('bash', [spike], {
    cwd,
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, LOG: log, STATE: state, SOCATPID: join(dir, 'socat.pid'), ...env },
  });
  const left = existsSync(state) ? readFileSync(state, 'utf8').split('\n').filter(Boolean) : [];
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { r, left, calls, terminates: calls.filter((l) => l.startsWith('nitro-cli terminate-enclave')) };
}

describe('t12-spike.sh exit status when it cannot be sure (adversary, T12 r3)', () => {
  it('sanity: a plain run leaves nothing and exits 0', () => {
    const { r, left } = runSpike({});
    expect(r.status, r.stderr).toBe(0);
    expect(left).toEqual([]);
  });

  // `run 16 || echo ...` lets the script carry on after a launch that may have started an enclave. If cleanup then
  // cannot list enclaves, it prints "check it and stop it by hand" but `return $rc` in an EXIT trap does not change
  // the exit status of a script that was exiting 0, so the host is left with an enclave and the script says success.
  it('a started-then-failed CID 16 that cleanup cannot locate leaves the enclave and must not exit 0', () => {
    const { r, left, calls } = runSpike({ START_THEN_FAIL_CID: '16', DESCRIBE_FAIL_FROM: '6' });
    const detail = JSON.stringify({ out: r.stdout, err: r.stderr, calls });
    expect(left, detail).toEqual(['i-fake-16 16']); // proves the enclave really is still running
    expect(r.stderr).toMatch(/cannot list enclaves to look for CID 16/);
    expect(r.status, detail).not.toBe(0);
  });

  // `terminate-enclave ... || true` hides a failed terminate: the enclave keeps running and the script exits 0 silently.
  it('a failed terminate-enclave is not hidden: exits non-zero and says so', () => {
    const { r, left } = runSpike({ TERMINATE_FAILS: '1' });
    expect(left.length).toBeGreaterThan(0); // enclaves are still running
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/terminate|stop it|still running/i);
  });
});

describe('t12-spike.sh only terminates what it started (adversary, T12 r3)', () => {
  // A seller starts on CID 16 after the preflight; our own run-enclave 16 fails (CID in use). Cleanup looks the
  // CID up in describe-enclaves and terminates the seller's enclave, which this run never started.
  it('does not terminate a foreign enclave that took an attempted CID after the preflight', () => {
    const { left, terminates } = runSpike({ FOREIGN_CID: '16' });
    expect(terminates).not.toContain('nitro-cli terminate-enclave --enclave-id i-seller-16');
    expect(left).toEqual(['i-seller-16 16']);
  });
});

describe('t12-spike.sh signals (adversary, T12 r3)', () => {
  // TERM arrives during run-enclave 18 (bash runs the trap when the command returns), so cleanup has to look the
  // enclave up by CID. That lookup takes a moment; a second TERM (an impatient operator) lands inside cleanup, where
  // `trap - EXIT INT TERM` has already restored the default action: the script dies at once, enclave 18 still
  // runs, and it says nothing.
  async function termDuringRun(second: boolean): Promise<{ left: string[]; err: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-adv-'));
    dirs.push(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const state = join(dir, 'enclaves');
    writeFileSync(state, '');
    fake(bin, 'uname', 'echo aarch64');
    fake(bin, 'docker', 'true');
    fake(bin, 'socat', 'exec sleep 60');
    fake(bin, 'node', 'true');
    fake(
      bin,
      'nitro-cli',
      `case "$1" in
  describe-enclaves)
    if [ -e "$STATE.slow" ]; then sleep 2; fi
    jq -R -s -c 'split("\\n") | map(select(length>0) | split(" ")) | map({EnclaveID: .[0], EnclaveCID: (.[1]|tonumber)})' "$STATE" ;;
  build-enclave) echo '{"Measurements":{}}' ;;
  run-enclave)
    while [ $# -gt 0 ]; do [ "$1" = --enclave-cid ] && cid=$2; shift; done
    echo "i-fake-$cid $cid" >> "$STATE"
    touch "$STATE.inrun"; sleep 1
    echo "{\\"EnclaveID\\":\\"i-fake-$cid\\",\\"EnclaveCID\\":$cid,\\"NumberOfCPUs\\":1,\\"MemoryMiB\\":1}" ;;
  terminate-enclave) grep -v "^$3 " "$STATE" > "$STATE.new" || true; mv "$STATE.new" "$STATE" ;;
esac`,
    );
    const cwd = join(dir, 'work');
    mkdirSync(cwd);
    const child = spawn('bash', [spike], { cwd, env: { PATH: `${bin}:${process.env.PATH}`, STATE: state } });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && !existsSync(`${state}.inrun`); i++) await sleep(50);
    child.kill('SIGTERM'); // handled when run-enclave returns, about 1 s later
    if (second) {
      writeFileSync(`${state}.slow`, '');
      await sleep(1500); // inside cleanup's describe-enclaves lookup
      child.kill('SIGTERM');
    }
    await exited;
    const left = readFileSync(state, 'utf8').split('\n').filter(Boolean);
    return { left, err };
  }

  it('one TERM during run-enclave still ends with the enclave terminated (guards the TERM trap)', async () => {
    const { left } = await termDuringRun(false);
    expect(left).toEqual([]);
  }, 20_000);

  it('a second TERM during cleanup does not leave an enclave running silently', async () => {
    const { left, err } = await termDuringRun(true);
    // Either nothing is left running, or the script said plainly that something is.
    if (left.length > 0) expect(err).toMatch(/still running|stop it by hand|cannot/);
  }, 20_000);
});

describe('ec2-host-setup.sh digest mismatch leaves nothing installed (adversary, T12 r3)', () => {
  const setupPath = fileURLToPath(new URL('../../../scripts/ec2-host-setup.sh', import.meta.url));
  const setupText = readFileSync(setupPath, 'utf8');
  const pinned = (name: string): string => new RegExp(`^${name}=([0-9a-f]+)`, 'm').exec(setupText)?.[1] as string;

  // Runs the real script with a recording sudo (nothing privileged runs) and curl that serves a file. The sha tools
  // are faked so the Node archive "matches" its pinned digest and the Caddy archive does not.
  function runSetup(badNode: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-adv-'));
    dirs.push(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'sudo.log');
    fake(bin, 'uname', 'echo aarch64');
    fake(bin, 'sudo', 'echo "sudo $*" >> "$LOG"; if [ "$1" = tee ]; then cat > /dev/null; fi');
    fake(bin, 'nitro-cli', 'echo "nitro-cli 1.5.2"');
    fake(bin, 'curl', 'out=; while [ $# -gt 0 ]; do [ "$1" = -fsSLo ] && out=$2; shift; done; echo archive > "$out"');
    fake(bin, 'sha256sum', `echo "${badNode ? 'bad'.padEnd(64, '0') : pinned('NODE_SHA256')}  $1"`);
    fake(bin, 'sha512sum', `echo "${'bad'.padEnd(128, '0')}  $1"`);
    const r = spawnSync('bash', [setupPath, 'a'.repeat(40)], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, LOG: log, HOME: dir },
    });
    const sudo = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { r, sudo };
  }
  const installs = (sudo: string[]): string[] =>
    sudo.filter((l) => /^sudo (dnf install|tee |systemctl (enable|restart)|usermod|tar |ln |\/usr\/local\/bin\/corepack)/.test(l));

  it('a Caddy digest mismatch stops the setup (sanity)', () => {
    const { r } = runSetup(false);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/DIGEST MISMATCH for caddy_/);
  });

  it('a Caddy digest mismatch has installed nothing: no Node extracted, no package, no group, no service restart', () => {
    const { sudo } = runSetup(false);
    expect(installs(sudo)).toEqual([]);
  });

  it('a Node digest mismatch has installed nothing: no package, no allocator config, no group, no service restart', () => {
    const { r, sudo } = runSetup(true);
    expect(r.stdout).toMatch(/DIGEST MISMATCH for node-/);
    expect(installs(sudo)).toEqual([]);
  });
});
