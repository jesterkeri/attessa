import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Adversary round 2 on T12 (08cae59). The real nitro-cli makes enclave names unique among running enclaves:
// aws-nitro-enclaves-cli src/lib.rs new_enclave_name(), called from src/main.rs before every run-enclave, appends
// "_1", "_2", ... when the requested name is already taken by a running enclave. The fake in host-scripts.test.ts
// records the requested name verbatim, so it cannot show what cleanup does with the names the real tool reports.
const spike = fileURLToPath(new URL('../../../scripts/t12-spike.sh', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function fake(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

// STATE holds "<EnclaveID> <EnclaveName>" per running enclave. run-enclave names the enclave the way the real CLI does.
// FAILAFTER_CID=c: the enclave for CID c starts and the command then exits 1 without printing its JSON.
function runSpike(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'attessa-adv4b-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const state = join(dir, 'enclaves');
  const log = join(dir, 'calls.log');
  writeFileSync(state, '');
  fake(bin, 'uname', 'echo aarch64');
  fake(bin, 'docker', 'true');
  fake(bin, 'socat', 'exec sleep 60');
  fake(bin, 'node', 'true');
  fake(
    bin,
    'nitro-cli',
    `echo "nitro-cli $*" >> "$LOG"
case "$1" in
  describe-enclaves)
    jq -R -s -c 'split("\\n") | map(select(length>0) | split(" ")) | map({EnclaveID: .[0], EnclaveCID: (.[0] | sub("^i-fake-";"") | tonumber), EnclaveName: .[1], State: "RUNNING"})' "$STATE" ;;
  build-enclave) echo '{"Measurements":{"PCR0":"00"}}' ;;
  run-enclave)
    while [ $# -gt 0 ]; do { [ "$1" = --enclave-cid ] && cid=$2; [ "$1" = --enclave-name ] && ename=$2; }; shift; done
    # lib.rs new_enclave_name: while the name is taken by a running enclave, try name_1, name_2, ...
    result=$ename; idx=0
    while awk '{print $2}' "$STATE" | grep -qxF -- "$result"; do idx=$((idx+1)); result="\${ename}_$idx"; done
    echo "i-fake-$cid $result" >> "$STATE"
    [ "$cid" != "\${FAILAFTER_CID:-}" ] || exit 1
    echo "{\\"EnclaveName\\":\\"$result\\",\\"EnclaveID\\":\\"i-fake-$cid\\",\\"EnclaveCID\\":$cid,\\"NumberOfCPUs\\":1,\\"MemoryMiB\\":1024}" ;;
  terminate-enclave)
    grep -Ev "^$3( |\\$)" "$STATE" > "$STATE.new" || true; mv "$STATE.new" "$STATE" ;;
esac`,
  );
  const cwd = join(dir, 'work');
  mkdirSync(cwd);
  const r = spawnSync('bash', [spike], {
    cwd,
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, LOG: log, STATE: state, ...env },
  });
  const left = readFileSync(state, 'utf8').split('\n').filter(Boolean);
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { r, left, calls };
}

describe('t12-spike.sh with a nitro-cli that de-duplicates enclave names (adversary, T12 r4)', () => {
  it('sanity: a plain run terminates all three and exits 0', () => {
    const { r, left } = runSpike({});
    expect(r.status, r.stderr).toBe(0);
    expect(left).toEqual([]);
  });

  // CID 18 is up under the run's name, so the real CLI names the next enclave "<name>_1". It starts, run-enclave
  // then fails without usable output, and cleanup has to recognise the enclave as its own by name.
  it('terminates the enclave it started for CID 16 when run-enclave fails after the start', () => {
    const { r, left } = runSpike({ FAILAFTER_CID: '16' });
    expect(left, r.stderr).toEqual([]);
  });
});
