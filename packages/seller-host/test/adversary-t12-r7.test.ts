import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Adversary round 7 for scripts/t12-spike.sh (commit fbcf795): the per-CID pre-launch snapshot file.
const spike = fileURLToPath(new URL('../../../scripts/t12-spike.sh', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function fake(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function run(env: Record<string, string>, script = spike, extra?: (bin: string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'attessa-adv7-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  const state = join(dir, 'state.lines');
  const log = join(dir, 'terminates.log');
  writeFileSync(state, '');
  fake(bin, 'uname', 'echo aarch64');
  fake(bin, 'docker', 'true');
  fake(bin, 'socat', 'exec sleep 60');
  fake(bin, 'node', 'true');
  fake(
    bin,
    'nitro-cli',
    `export LC_ALL=C
case "$1" in
  describe-enclaves) printf '['; cut -f2- "$STATE" | paste -sd, | tr -d '\\n'; printf ']\\n' ;;
  build-enclave) echo '{"Measurements":{"PCR0":"00"}}' ;;
  run-enclave)
    while [ $# -gt 0 ]; do { [ "$1" = --enclave-cid ] && cid=$2; [ "$1" = --enclave-name ] && ename=$2; }; shift; done
    v="ID_JSON_$cid"; idj=\${!v:-\\"i-fake-$cid\\"}; idj=\${idj//@FF@/$'\\xff'}
    rec="{\\"EnclaveID\\":$idj,\\"EnclaveCID\\":$cid,\\"EnclaveName\\":\\"$ename\\",\\"NumberOfCPUs\\":1,\\"MemoryMiB\\":1024}"
    rv="ID_RAW_$cid"; raw=\${!rv:-i-fake-$cid}; raw=\${raw//@FF@/$'\\xff'}
    printf '%s\\t%s\\n' "$raw" "$rec" >> "$STATE"
    x="EXTRA_$cid"; [ -z "\${!x:-}" ] || { xr=\${!x}; xr=\${xr//@FF@/$'\\xff'}; printf '%s\\t%s\\n' "$(printf '%s' "$xr" | jq -r '.EnclaveID')" "$xr" >> "$STATE"; }
    [ -z "\${RM_OUTD_AFTER:-}" ] || [ "$cid" != "$RM_OUTD_AFTER" ] || rm -rf "$TMPDIR"/tmp.*
    o="OUT_$cid"; [ "\${!o:-}" = none ] || printf '%s\\n' "$rec" ;;
  terminate-enclave)
    printf '%s\\n' "$3" >> "$LOG"
    while IFS= read -r line; do [ "\${line%%$'\\t'*}" = "$3" ] || printf '%s\\n' "$line"; done < "$STATE" > "$STATE.new"; mv "$STATE.new" "$STATE" ;;
esac`,
  );
  extra?.(bin, dir);
  const cwd = join(dir, 'work');
  mkdirSync(cwd);
  const r = spawnSync('bash', [script], {
    cwd,
    encoding: 'buffer',
    env: { PATH: `${bin}:${process.env.PATH}`, STATE: state, LOG: log, TMPDIR: tmp, ...env },
  });
  const terminates = existsSync(log) ? readFileSync(log).toString('latin1').split('\n').filter(Boolean) : [];
  const left = readFileSync(state).toString('latin1');
  return { r, terminates, left, stderr: r.stderr.toString('utf8'), dir };
}

describe('t12-spike.sh adversary round 7 (pre-launch snapshot file)', () => {
  // Control: a clean run terminates all three and exits 0.
  it('control: clean run', () => {
    const { r, terminates, left } = run({});
    expect(r.status).toBe(0);
    expect(terminates.sort()).toEqual(['i-fake-16', 'i-fake-17', 'i-fake-18']);
    expect(left).toBe('');
  });

  // The pre-launch snapshot is compared on jq-decoded ids. A foreign enclave whose id has an invalid byte decodes to the
  // same string as ours (U+FFFD), so ours looks "present before launch" and is skipped with no message at all.
  it('names or terminates its own CID 16 enclave even when a foreign pre-existing id decodes to the same string', () => {
    const { r, terminates, left, stderr } = run({
      EXTRA_18: '{"EnclaveID":"i-@FF@-z","EnclaveCID":99,"EnclaveName":"seller-99"}',
      ID_JSON_16: '"i-\\ufffd-z"',
      ID_RAW_16: 'i-\u{fffd}-z',
      OUT_16: 'none',
    });
    const still16 = left.includes('"EnclaveCID":16');
    const named16 = /CID 16/.test(stderr);
    expect(!still16 || named16, `enclave 16 left running and never named. status=${r.status} stdout=${r.stdout.toString()} stderr=${stderr} left=${left}`).toBe(true);
    expect(r.status).not.toBe(0);
    expect(terminates.join('|')).not.toContain('seller');
  });

  // $OUTD vanishes after the enclave started: the snapshot and the output are gone. Must be named and non-zero at least.
  it('OUTD removed after the launch: enclave named, non-zero exit', () => {
    const { r, left, stderr } = run({ RM_OUTD_AFTER: '18', OUT_18: 'none' });
    const still18 = left.includes('"EnclaveCID":18');
    expect(r.status).not.toBe(0);
    expect(!still18 || /CID 18/.test(stderr), stderr).toBe(true);
  });

  // Empty snapshot file (signal/failed write before launch) and a foreign enclave on the CID: never ours.
  it('empty snapshot file does not make a foreign enclave ours', () => {
    const realJq = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
    const wrap = (bin: string) => {
      fake(
        bin,
        'jq',
        `if [ "\${1:-}" = -c ] && [ "\${2:-}" = '[.[].EnclaveID]' ]; then
  printf '%s\\t%s\\n' i-seller-18 '{"EnclaveID":"i-seller-18","EnclaveCID":18,"EnclaveName":"seller-18"}' >> "$STATE"
  exit 1
fi
exec ${realJq} "$@"`,
      );
    };
    const { r, terminates, left, stderr } = run({}, spike, wrap);
    expect(terminates).not.toContain('i-seller-18');
    expect(left).toContain('seller-18');
    expect(r.status).not.toBe(0);
    expect(stderr).toMatch(/i-seller-18/);
  });
});

describe('t12-spike.sh adversary round 7 (signal between KNOWN and STARTED)', () => {
  // window.sh is the script with one `kill -TERM $$` inserted between `STARTED+=...` and `KNOWN+=...` in run(): that is
  // where a real signal can land (bash runs a trap between two simple commands). Cleanup then skips CID 18 as KNOWN
  // while STARTED does not hold its id, so the enclave is neither terminated nor named.
  it('a signal between KNOWN+= and STARTED+= still terminates or names the enclave', () => {
    const src = readFileSync(spike, 'utf8');
    const marker = 'STARTED+=("$id"); KNOWN+="$cid "';
    expect(src).toContain(marker);
    const windowDir = mkdtempSync(join(tmpdir(), 'attessa-window-'));
    dirs.push(windowDir);
    const window = join(windowDir, 'window.sh');
    writeFileSync(window, src.replace(marker, 'STARTED+=("$id"); kill -TERM $$; KNOWN+="$cid "'));
    const { r, left, stderr } = run({}, window);
    const still18 = left.includes('"EnclaveCID":18');
    expect(!still18 || /CID 18|i-fake-18/.test(stderr), `status=${r.status} stderr=${stderr} left=${left}`).toBe(true);
  });
});
