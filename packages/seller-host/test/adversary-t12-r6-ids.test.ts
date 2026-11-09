import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Adversary round 6 for scripts/t12-spike.sh (commit dac8412). A byte-exact fake host: $STATE holds one raw JSON
// record per line and describe-enclaves prints them as an array, so an EnclaveID can carry bytes that are not
// UTF-8. ID_JSON_<cid> is the JSON text of the EnclaveID the started enclave gets; the marker @FF@ in it becomes the
// raw byte 0xff. terminate-enclave logs the exact bytes of its argument and removes the record whose id matches
// byte for byte. EXTRA_<cid>=<json record> adds a second enclave (a seller starting concurrently) when <cid> launches.
// OUT_<cid>=none makes run-enclave print nothing although the enclave started.
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
  const dir = mkdtempSync(join(tmpdir(), 'attessa-adv6-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
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
    xf="EXTRAFILE_$cid"; [ -z "\${!xf:-}" ] || cat "\${!xf}" >> "$STATE"
    o="OUT_$cid"; [ "\${!o:-}" = none ] || printf '%s\\n' "$rec" ;;
  terminate-enclave)
    printf '%s\\n' "$3" >> "$LOG"
    while IFS= read -r line; do [ "\${line%%$'\\t'*}" = "$3" ] || printf '%s\\n' "$line"; done < "$STATE" > "$STATE.new"; mv "$STATE.new" "$STATE" ;;
esac`,
  );
  const cwd = join(dir, 'work');
  mkdirSync(cwd);
  const r = spawnSync('bash', [spike], {
    cwd,
    encoding: 'buffer',
    env: { PATH: `${bin}:${process.env.PATH}`, STATE: state, LOG: log, ...env },
  });
  const terminates = existsSync(log) ? readFileSync(log).toString('latin1').split('\n').filter(Boolean) : [];
  const left = readFileSync(state).toString('latin1');
  return { r, terminates, left, stderr: r.stderr.toString('utf8') };
}

const latin1 = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');
// The three bytes jq writes for a byte it cannot decode (U+FFFD), read as latin1 like the log.
const FFFD = latin1('�');

describe('t12-spike.sh adversary round 6', () => {
  // jq decodes the host's bytes and re-encodes them: an invalid byte becomes U+FFFD. The id handed to
  // terminate-enclave is then not what the host reported, and it can be the id of a different enclave.
  it('never terminates an enclave other than the one it started (invalid UTF-8 id collapses to another id)', () => {
    const foreign = `{"EnclaveID":"i-�-18","EnclaveCID":99,"EnclaveName":"seller-99"}`;
    const { terminates, left } = run({ ID_JSON_18: '"i-@FF@-18"', ID_RAW_18: 'i-@FF@-18', EXTRA_18: foreign });
    expect(terminates).not.toContain(`i-${FFFD}-18`);
    expect(left).toContain('seller-99');
  });

  // jq can't carry those bytes, so the script can't hand over the host's exact id: it names the enclave and fails.
  it('names an id with invalid UTF-8 and leaves it running, with a non-zero exit', () => {
    const { r, terminates, left } = run({ ID_JSON_18: '"i-@FF@-18"', ID_RAW_18: 'i-@FF@-18' });
    expect(r.status).not.toBe(0);
    expect(terminates).toEqual([]);
    expect(String(r.stderr)).toMatch(/cannot prove it started it/);
    expect(left).toContain('"EnclaveCID":18');
  });

  it.each([
    ['a leading space', '" i-18"', ' i-18'],
    ['a trailing space', '"i-18 "', 'i-18 '],
    ['quotes', '"i-\\"q\\"\'x"', 'i-"q"\'x'],
    ['a command substitution', '"$(touch PWNED)-18"', '$(touch PWNED)-18'],
    ['a glob', '"i-*-?-[a]"', 'i-*-?-[a]'],
    ['non-ASCII', '"i-\\u00e9\\u4e2d-18"', 'i-é中-18'],
    ['an astral character', '"i-\\ud83d\\ude00-18"', 'i-\u{1f600}-18'],
  ])('terminates exactly the id it started, found by name only (%s)', (_n, json, raw) => {
    const { r, terminates, left } = run({ ID_JSON_18: json, ID_RAW_18: raw, OUT_18: 'none' });
    expect(r.status).not.toBe(0);
    expect(terminates).toContain(latin1(raw));
    expect(left).not.toContain('"EnclaveCID":18');
  });

  it('terminates a 100 KB id it started, found by name only', () => {
    const id = 'i-' + 'a'.repeat(100_000);
    const { terminates, left } = run({ ID_JSON_18: `"${id}"`, ID_RAW_18: id, OUT_18: 'none' });
    expect(terminates).toContain(id);
    expect(left).not.toContain('"EnclaveCID":18');
  });

  // The pre-launch snapshot travels to jq as one argument. A foreign enclave with a very long id (the kernel caps one
  // argument at 128 KiB) makes that exec fail, and the failure is swallowed: an enclave this run started is neither
  // terminated nor named.
  it('terminates or names an enclave it started when another enclave on the host has a huge id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-adv6x-'));
    dirs.push(dir);
    const big = 'i-' + 'b'.repeat(140_000);
    const file = join(dir, 'extra');
    writeFileSync(file, `${big}\t{"EnclaveID":"${big}","EnclaveCID":99,"EnclaveName":"seller-99"}\n`);
    const { r, terminates, left, stderr } = run({ EXTRAFILE_18: file, OUT_16: 'none' });
    const stillRunning = left.includes('"EnclaveCID":16');
    const named = /CID 16/.test(stderr);
    expect(!stillRunning || named).toBe(true);
    expect(terminates).not.toContain(big);
    expect(r.status).not.toBe(0);
  });
});
