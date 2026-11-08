import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repo = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const spike = repo('scripts/t12-spike.sh');
const setupPath = repo('scripts/ec2-host-setup.sh');
const setup = readFileSync(setupPath, 'utf8');
const runbook = readFileSync(repo('docs/EC2-RUNBOOK.md'), 'utf8');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function sandbox(): { dir: string; bin: string; state: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'attessa-host-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  return { dir, bin, state: join(dir, 'enclaves'), log: join(dir, 'calls.log') };
}
function fake(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

// A fake host: nitro-cli keeps a list of "enclaves" in $STATE and logs every call to $LOG.
function fakeHost(bin: string): void {
  fake(bin, 'uname', 'echo aarch64');
  fake(bin, 'docker', 'echo "docker $*" >> "$LOG"');
  fake(bin, 'socat', 'echo "socat $*" >> "$LOG"; echo $$ > "$SOCATPID"; exec sleep 60');
  fake(bin, 'node', 'echo "node $*" >> "$LOG"; [ -z "${FAIL_NODE:-}" ]');
  fake(
    bin,
    'nitro-cli',
    `echo "nitro-cli $*" >> "$LOG"
touch "$STATE"
case "$1" in
  describe-enclaves)
    [ -z "\${DESCRIBE_FAIL:-}" ] || exit 1
    if [ -n "\${DESCRIBE_RAW+x}" ]; then printf '%s' "$DESCRIBE_RAW"; exit 0; fi
    jq -R -s -c 'split("\\n") | map(select(length>0)) | map({EnclaveID: ., EnclaveCID: (try (sub("^i-fake-";"") | tonumber) catch 0)})' "$STATE" ;;
  build-enclave) echo '{"Measurements":{"PCR0":"00"}}' ;;
  run-enclave)
    while [ $# -gt 0 ]; do [ "$1" = --enclave-cid ] && cid=$2; shift; done
    [ "$cid" != "\${FAIL_CID:-}" ] || exit 1
    echo "i-fake-$cid" >> "$STATE"
    # RUN_MODE: malformed = the enclave starts but the output lacks EnclaveID; garbage = not JSON at all;
    # failafter = the enclave starts and the command then exits 1 (no usable output).
    case "\${RUN_MODE:-}" in
      malformed) echo "{\\"EnclaveCID\\":$cid}"; exit 0 ;;
      garbage) printf '{"EnclaveCID": 1'; exit 0 ;;
      failafter) exit 1 ;;
    esac
    echo "{\\"EnclaveID\\":\\"i-fake-$cid\\",\\"EnclaveCID\\":$cid,\\"NumberOfCPUs\\":1,\\"MemoryMiB\\":1024}" ;;
  terminate-enclave)
    if [ "$2" = --all ]; then : > "$STATE"; exit 0; fi
    grep -vx "$3" "$STATE" > "$STATE.new" || true; mv "$STATE.new" "$STATE" ;;
esac`,
  );
}

function runSpike(env: Record<string, string> = {}, pre: string[] = []) {
  const sb = sandbox();
  fakeHost(sb.bin);
  writeFileSync(sb.state, pre.map((p) => `${p}\n`).join(''));
  const cwd = join(sb.dir, 'work');
  mkdirSync(cwd);
  const r = spawnSync('bash', [spike], {
    cwd,
    encoding: 'utf8',
    env: { PATH: `${sb.bin}:${process.env.PATH}`, LOG: sb.log, STATE: sb.state, SOCATPID: join(sb.dir, 'socat.pid'), ...env },
  });
  const log = existsSync(sb.log) ? readFileSync(sb.log, 'utf8').split('\n').filter(Boolean) : [];
  return { r, log, sb, terminates: log.filter((l) => l.startsWith('nitro-cli terminate-enclave')) };
}

describe('t12-spike.sh never terminates an enclave it did not start', () => {
  it('has no terminate-enclave --all anywhere', () => {
    expect(readFileSync(spike, 'utf8')).not.toMatch(/terminate-enclave\s+--all/);
  });

  it('refuses when an enclave is already running, and makes no terminate call', () => {
    const { r, log, terminates } = runSpike({}, ['i-live-seller']);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/refusing to run: 1 enclave/);
    expect(terminates).toEqual([]);
    expect(log.some((l) => l.startsWith('nitro-cli run-enclave') || l.startsWith('docker'))).toBe(false);
  });

  it('a normal run terminates exactly the three enclaves it started, by id, and stops socat', () => {
    const { r, terminates, sb } = runSpike();
    expect(r.status, r.stderr).toBe(0);
    expect(terminates.sort()).toEqual(
      ['i-fake-16', 'i-fake-17', 'i-fake-18'].map((id) => `nitro-cli terminate-enclave --enclave-id ${id}`),
    );
    const pid = readFileSync(join(sb.dir, 'socat.pid'), 'utf8').trim();
    expect(spawnSync('kill', ['-0', pid]).status).not.toBe(0);
  });

  it('a failure midway still terminates what it started, only that', () => {
    const { r, terminates } = runSpike({ FAIL_NODE: '1' });
    expect(r.status).not.toBe(0);
    expect(terminates).toEqual(['nitro-cli terminate-enclave --enclave-id i-fake-18']);
  });
});

describe('t12-spike.sh fails closed on malformed Nitro CLI results', () => {
  const noStart = (log: string[]): boolean =>
    !log.some((l) => /^(docker|nitro-cli (build-enclave|run-enclave|terminate-enclave))/.test(l));

  // Codex T12 r2 M2: `jq length` read null and {} as an empty host.
  it.each([
    ['null', 'null'],
    ['an object', '{}'],
    ['an object with a list inside', '{"Enclaves":[]}'],
    ['an empty string', ''],
    ['not JSON', 'oops'],
    ['a record with no EnclaveID', '[{"EnclaveCID":18}]'],
    ['a non-object record', '[1]'],
    ['a record with no EnclaveCID', '[{"EnclaveID":"i-x"}]'],
  ])('refuses without building or starting anything when describe-enclaves returns %s', (_n, raw) => {
    const { r, log, sb } = runSpike({ DESCRIBE_RAW: raw });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/refusing to run: cannot establish/);
    expect(noStart(log)).toBe(true);
    expect(existsSync(join(sb.dir, 'work', 'build'))).toBe(false);
  });

  it('refuses when describe-enclaves itself fails', () => {
    const { r, log } = runSpike({ DESCRIBE_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/refusing to run: cannot establish/);
    expect(noStart(log)).toBe(true);
  });

  it('still accepts a well-formed empty list', () => {
    const { r, log } = runSpike({ DESCRIBE_RAW: '[]' });
    expect(r.status, r.stderr).toBe(0);
    expect(log.some((l) => l.startsWith('nitro-cli run-enclave'))).toBe(true);
  });

  // Codex T12 r2 M1: the enclave starts, then run-enclave output is unusable; the id must be found by CID.
  it.each([
    ['output without EnclaveID', 'malformed'],
    ['output that is not JSON', 'garbage'],
    ['a failure after the start', 'failafter'],
  ])('terminates the enclave it started when run-enclave gives %s', (_n, mode) => {
    const { r, terminates } = runSpike({ RUN_MODE: mode });
    expect(r.status).not.toBe(0);
    // run 18 fails first, so the script stops there; exactly that enclave is found by CID and terminated.
    expect(terminates).toEqual(['nitro-cli terminate-enclave --enclave-id i-fake-18']);
  });

  it('cleanup never terminates a pre-existing enclave, even when launches are malformed', () => {
    const { r, terminates } = runSpike({ RUN_MODE: 'malformed', DESCRIBE_RAW: '[]' });
    expect(r.status).not.toBe(0);
    expect(terminates.every((t) => /i-fake-1[678]$/.test(t))).toBe(true);
  });

  it('reports plainly when cleanup cannot list enclaves to find a started one', () => {
    // describe-enclaves works for the preflight, then fails: the enclave of CID 18 cannot be located.
    const sb = sandbox();
    fakeHost(sb.bin);
    const real = readFileSync(join(sb.bin, 'nitro-cli'), 'utf8');
    writeFileSync(join(sb.bin, 'nitro-cli'), real.replace('describe-enclaves)', 'describe-enclaves)\n    if [ -e "$STATE.seen" ]; then exit 1; fi; touch "$STATE.seen"'));
    writeFileSync(sb.state, '');
    const cwd = join(sb.dir, 'work');
    mkdirSync(cwd);
    const r = spawnSync('bash', [spike], {
      cwd, encoding: 'utf8',
      env: { PATH: `${sb.bin}:${process.env.PATH}`, LOG: sb.log, STATE: sb.state, SOCATPID: join(sb.dir, 'socat.pid'), RUN_MODE: 'malformed' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/cannot list enclaves to look for CID 18; check it and stop it by hand/);
  });
});

describe('EC2-RUNBOOK.md secret file modes', () => {
  it('states 0600 for seller and gateway secrets and never a wider mode for them', () => {
    expect(runbook).toMatch(/mode 0600, owner root:root/);
    expect(runbook).toMatch(/seller-<n>\.secret/);
    for (const line of runbook.split('\n').filter((l) => /secret/.test(l))) {
      expect(line, line).not.toMatch(/\b0?(640|644|660|664|666|750|755)\b/);
    }
    expect(runbook).not.toMatch(/secrets? in your own terminal, mode 0?640/);
    expect(setup).not.toMatch(/secret[^\n]*0640/);
  });
});

describe('ec2-host-setup.sh pins the downloaded archives', () => {
  it('holds a 64-hex and a 128-hex constant and fetches no checksum file', () => {
    expect(setup).toMatch(/^NODE_SHA256=[0-9a-f]{64}\s/m);
    expect(setup).toMatch(/^CADDY_SHA512=[0-9a-f]{128}\s/m);
    expect(setup).not.toMatch(/SHASUMS256\.txt"|checksums\.txt"|_checksums/);
    expect(setup).not.toMatch(/sha(256|512)sum -c/);
  });

  it('verifies before each privileged extraction and always downloads', () => {
    expect(setup.indexOf('fetch_verified "https://nodejs.org')).toBeLessThan(setup.indexOf('sudo tar -xJf'));
    expect(setup.indexOf('fetch_verified "https://github.com')).toBeLessThan(setup.indexOf('sudo tar -xzf'));
    expect(setup).not.toMatch(/\/usr\/local\/bin\/(node -v|caddy version)|if ! \/usr/);
  });

  // Runs the real fetch_verified with a fake curl that serves a tampered archive AND would serve a matching checksum.
  it('a tampered archive cannot pass, an untouched one does', () => {
    const fn = /^fetch_verified\(\) \{\n[\s\S]*?\n\}\n/m.exec(setup)?.[0];
    expect(fn).toBeTruthy();
    const check = (served: string, algo: 'sha256' | 'sha512', expected: string) => {
      const sb = sandbox();
      fake(sb.bin, 'curl', `out=; while [ $# -gt 0 ]; do [ "$1" = -fsSLo ] && out=$2; shift; done; printf '%s' "$SERVED" > "$out"; echo "curl $*" >> "$LOG"`);
      const script = join(sb.dir, 'run.sh');
      writeFileSync(script, `set -euo pipefail\nTMP=${sb.dir}\n${fn}\nfetch_verified https://x/a.tgz a.tgz ${algo} ${expected}\necho INSTALLED\n`);
      return spawnSync('bash', [script], { encoding: 'utf8', env: { PATH: `${sb.bin}:${process.env.PATH}`, SERVED: served, LOG: sb.log } });
    };
    const digest = (algo: string, data: string) =>
      spawnSync(`printf '%s' '${data}' | ${algo}sum | cut -d' ' -f1`, { shell: true, encoding: 'utf8' }).stdout.trim();
    for (const algo of ['sha256', 'sha512'] as const) {
      const bad = check('malicious', algo, digest(algo, 'genuine'));
      expect(bad.status, algo).not.toBe(0);
      expect(bad.stdout).toMatch(/DIGEST MISMATCH/);
      expect(bad.stdout).not.toMatch(/INSTALLED/);
      const good = check('genuine', algo, digest(algo, 'genuine'));
      expect(good.status, good.stderr).toBe(0);
      expect(good.stdout).toMatch(/INSTALLED/);
    }
  });
});
