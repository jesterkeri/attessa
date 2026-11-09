import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Adversary probes for scripts/t12-spike.sh (commit 78a8bb4). A JSON-state fake host: $STATE is the list
// describe-enclaves prints. Per CID, ID_JSON_<cid> is the JSON literal of the EnclaveID the started enclave gets
// (a JSON literal, so it can carry \u0000), and OUT_<cid>=none prints nothing from run-enclave (the enclave still starts).
const spike = fileURLToPath(new URL('../../../scripts/t12-spike.sh', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function fake(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'attessa-adv-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const state = join(dir, 'state.json');
  const log = join(dir, 'terminates.log');
  writeFileSync(state, '[]');
  fake(bin, 'uname', 'echo aarch64');
  fake(bin, 'docker', 'true');
  fake(bin, 'socat', 'exec sleep 60');
  fake(bin, 'node', 'true');
  fake(
    bin,
    'nitro-cli',
    `case "$1" in
  describe-enclaves) cat "$STATE" ;;
  build-enclave) echo '{"Measurements":{"PCR0":"00"}}' ;;
  run-enclave)
    while [ $# -gt 0 ]; do { [ "$1" = --enclave-cid ] && cid=$2; [ "$1" = --enclave-name ] && ename=$2; }; shift; done
    v="ID_JSON_$cid"; idj=\${!v:-\\"i-fake-$cid\\"}
    rec=$(jq -nc --argjson id "$idj" --argjson cid "$cid" --arg n "$ename" '{EnclaveID:$id,EnclaveCID:$cid,EnclaveName:$n,NumberOfCPUs:1,MemoryMiB:1024}')
    jq -c --argjson r "$rec" '. + [$r]' "$STATE" > "$STATE.new"; mv "$STATE.new" "$STATE"
    o="OUT_$cid"; [ "\${!o:-}" = none ] || printf '%s\\n' "$rec" ;;
  terminate-enclave)
    printf '%s\\n' "$3" >> "$LOG"
    jq -c --arg id "$3" 'map(select(.EnclaveID != $id))' "$STATE" > "$STATE.new"; mv "$STATE.new" "$STATE" ;;
esac`,
  );
  const cwd = join(dir, 'work');
  mkdirSync(cwd);
  const r = spawnSync('bash', [spike], {
    cwd,
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, STATE: state, LOG: log, ...env },
  });
  const terminates = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  const left = JSON.parse(readFileSync(state, 'utf8')) as { EnclaveID: string }[];
  return { r, terminates, left };
}

describe('t12-spike.sh adversary probes', () => {
  // Bash drops NUL from command substitution, so the id it terminates is not the id run-enclave printed.
  it('never terminates an id different from the one run-enclave printed (NUL inside EnclaveID)', () => {
    const { r, terminates } = run({ ID_JSON_18: '"i-sel\\u0000ler-18"' });
    expect(terminates).not.toContain('i-seller-18');
    expect(r.status).not.toBe(0);
  });

  // The snapshot is a space-joined string matched with a glob: an id with a space word-splits and hides a started enclave.
  it('terminates an enclave it started even when a pre-launch id contains a space', () => {
    const { r, terminates, left } = run({ ID_JSON_18: '"a b"', ID_JSON_16: '"b"', OUT_16: 'none' });
    expect(r.status).not.toBe(0);
    expect(left.map((e) => e.EnclaveID)).not.toContain('b');
    expect(terminates).toContain('b');
  });

  // @tsv escapes backslash and tab, so the id read back from the snapshot is not the id on the host.
  it('terminates the exact id of an enclave it started, found by name (backslash in id)', () => {
    const { r, terminates, left } = run({ ID_JSON_18: '"i-x\\\\y"', OUT_18: 'none' });
    expect(r.status).not.toBe(0);
    expect(left.map((e) => e.EnclaveID)).not.toContain('i-x\\y');
    expect(terminates).toContain('i-x\\y');
  });

  it.each([
    ['a flag', '"--all"'],
    ['a newline', '"i-x\\ny"'],
    ['a tab', '"i-x\\ty"'],
  ])('names an id that reads as %s and leaves it running, with a non-zero exit', (_n, id) => {
    const { r, terminates } = run({ ID_JSON_18: id });
    expect(r.status).not.toBe(0);
    expect(terminates).toEqual([]);
    expect(r.stderr).toMatch(/cannot prove it started it/);
  });
});
