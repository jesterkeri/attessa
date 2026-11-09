import { spawn, spawnSync } from 'node:child_process';
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
    n=$(cat "$STATE.calls" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$STATE.calls"
    [ -z "\${DESCRIBE_FAIL:-}" ] || exit 1
    if [ -n "\${DESCRIBE_FAIL_FROM:-}" ] && [ "$n" -ge "$DESCRIBE_FAIL_FROM" ]; then exit 1; fi
    if [ -n "\${DESCRIBE_RAW+x}" ]; then printf '%s' "$DESCRIBE_RAW"; exit 0; fi
    # state lines are "<id>" or "<id> <name>"; the CID is the number after "i-fake-" or "i-seller-"
    jq -R -s -c 'split("\\n") | map(select(length>0) | split(" ")) | map({EnclaveID: .[0], EnclaveCID: (try (.[0] | sub("^i-(fake|seller)-";"") | tonumber) catch 0)} + (if .[1] then {EnclaveName: .[1]} else {} end))' "$STATE" ;;
  build-enclave)
    # SEIZE_CID: a seller takes this CID while the image builds, after the script's first look at the host
    [ -z "\${SEIZE_CID:-}" ] || echo "i-seller-$SEIZE_CID" >> "$STATE"
    echo '{"Measurements":{"PCR0":"00"}}' ;;
  run-enclave)
    while [ $# -gt 0 ]; do { [ "$1" = --enclave-cid ] && cid=$2; [ "$1" = --enclave-name ] && ename=$2; }; shift; done
    [ "$cid" != "\${FAIL_CID:-}" ] || exit 1
    # FOREIGN_CID: someone else's enclave takes this CID right before our call, which then fails
    if [ "$cid" = "\${FOREIGN_CID:-}" ]; then echo "i-seller-$cid" >> "$STATE"; exit 1; fi
    echo "i-fake-$cid $ename" >> "$STATE"
    # RUN_MODE: malformed = the enclave starts but the output lacks EnclaveID; garbage = not JSON at all;
    # failafter = the enclave starts and the command then exits 1 (no usable output).
    # FAILAFTER_CID: the same as failafter, for that CID only.
    [ "$cid" != "\${FAILAFTER_CID:-}" ] || exit 1
    case "\${RUN_MODE:-}" in
      malformed) echo "{\\"EnclaveCID\\":$cid}"; exit 0 ;;
      garbage) printf '{"EnclaveCID": 1'; exit 0 ;;
      failafter) exit 1 ;;
    esac
    # WRONG_RESP_CID: the enclave for this CID starts, but the printed response is a well-formed foreign one
    if [ "$cid" = "\${WRONG_RESP_CID:-}" ]; then echo '{"EnclaveID":"i-seller-16","EnclaveCID":16,"EnclaveName":"someone-else","NumberOfCPUs":1,"MemoryMiB":1024}'; exit 0; fi
    # WRONG_NAME_CID: the printed response has the requested CID but someone else's id and name.
    if [ "$cid" = "\${WRONG_NAME_CID:-}" ]; then echo "{\\"EnclaveID\\":\\"i-seller-$cid\\",\\"EnclaveCID\\":$cid,\\"EnclaveName\\":\\"someone-else\\"}"; exit 0; fi
    # TWO_DOCS_CID: two JSON documents, a foreign one on the requested CID and then our own.
    if [ "$cid" = "\${TWO_DOCS_CID:-}" ]; then echo "{\\"EnclaveID\\":\\"i-seller-$cid\\",\\"EnclaveCID\\":$cid,\\"EnclaveName\\":\\"$ename\\"}"; echo "{\\"EnclaveName\\":\\"$ename\\",\\"EnclaveID\\":\\"i-fake-$cid\\",\\"EnclaveCID\\":$cid}"; exit 0; fi
    if [ "$(cat "$STATE.slowrun" 2>/dev/null)" = "$cid" ]; then touch "$STATE.inrun"; sleep 1; fi
    echo "{\\"EnclaveName\\":\\"$ename\\",\\"EnclaveID\\":\\"i-fake-$cid\\",\\"EnclaveCID\\":$cid,\\"NumberOfCPUs\\":1,\\"MemoryMiB\\":1024}" ;;
  terminate-enclave)
    if [ "$2" = --all ]; then : > "$STATE"; exit 0; fi
    [ -z "\${TERMINATE_FAILS:-}" ] || exit 1
    if [ -e "$STATE.slowterm" ]; then sleep 1; fi
    grep -Ev "^$3( |\\$)" "$STATE" > "$STATE.new" || true; mv "$STATE.new" "$STATE" ;;
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
    // The preflight accepts []; the run then fails at the end because the fake keeps listing [] (fewer than three).
    const { log } = runSpike({ DESCRIBE_RAW: '[]' });
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
    // describe-enclaves works for the preflight and the snapshot before CID 18 (2 calls), then fails: the enclave of CID 18 cannot be located.
    const sb = sandbox();
    fakeHost(sb.bin);
    const real = readFileSync(join(sb.bin, 'nitro-cli'), 'utf8');
    writeFileSync(join(sb.bin, 'nitro-cli'), real.replace('describe-enclaves)', 'describe-enclaves)\n    c=$(cat "$STATE.seen" 2>/dev/null || echo 0); c=$((c+1)); echo $c > "$STATE.seen"; [ "$c" -le 2 ] || exit 1'));
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

// T12 adversary r3 / Codex follow-up: ownership, swallowed terminate failures, exit status, signals.
describe('t12-spike.sh ownership and truthful exit status', () => {
  const T = (id: string) => `nitro-cli terminate-enclave --enclave-id ${id}`;

  it('does not launch onto a CID a seller took after the preflight, and does not terminate the seller', () => {
    const { r, log, terminates } = runSpike({ SEIZE_CID: '16' });
    expect(log.some((l) => /run-enclave .*--enclave-cid 16\b/.test(l))).toBe(false);
    expect(terminates).not.toContain(T('i-seller-16'));
    expect(terminates).toEqual([T('i-fake-18')]);   // a refused CID 16 now stops the run before CID 17
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/refusing to start CID 16/);
  });

  it('refuses to launch when the pre-launch snapshot cannot be read', () => {
    // preflight is call 1, the snapshot before CID 18 is call 2
    const { r, log } = runSpike({ DESCRIBE_FAIL_FROM: '2' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/refusing to start CID 18: cannot establish/);
    expect(log.some((l) => l.startsWith('nitro-cli run-enclave'))).toBe(false);
  });

  it('a foreign enclave that appears on an attempted CID during a failed launch is left alone, named, exit non-zero', () => {
    const { r, terminates, sb } = runSpike({ FOREIGN_CID: '16' });
    expect(terminates).not.toContain(T('i-seller-16'));
    expect(readFileSync(sb.state, 'utf8')).toMatch(/^i-seller-16$/m);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/i-seller-16 holds CID 16.*NOT terminating/);
    expect(terminates).toEqual([T('i-fake-18')]);   // the failed CID 16 launch stops the run before CID 17
  });

  it('an enclave carrying our name is ours even when run-enclave printed nothing usable', () => {
    const { terminates } = runSpike({ FAILAFTER_CID: '16' });
    expect(terminates).toContain(T('i-fake-16'));
  });

  it('a failed terminate-enclave is reported with the id still running, and the exit is non-zero', () => {
    const { r, sb } = runSpike({ TERMINATE_FAILS: '1' });
    expect(r.status).not.toBe(0);
    for (const id of ['i-fake-16', 'i-fake-17', 'i-fake-18']) {
      expect(r.stderr).toContain(`terminate-enclave FAILED: enclave ${id} is still running`);
      expect(readFileSync(sb.state, 'utf8')).toContain(id);
    }
  });

  it('a cleanup that cannot locate a started enclave exits non-zero even when the run itself was fine', () => {
    // calls: preflight 1, snapshots 2-3 (18, 16), cleanup lookup 4. CID 16 starts and then fails, which ends the run.
    const { r, sb } = runSpike({ FAILAFTER_CID: '16', DESCRIBE_FAIL_FROM: '4' });
    expect(r.stderr).toMatch(/cannot list enclaves to look for CID 16; check it and stop it by hand/);
    expect(readFileSync(sb.state, 'utf8')).toContain('i-fake-16');
    expect(r.status).not.toBe(0);
  });

  it('a clean run exits 0 (guards the non-zero paths above)', () => {
    expect(runSpike().r.status).toBe(0);
  });
});

// Codex T12 r3: a failed CID 16/17 launch must fail the spike; a run-enclave response is trusted only if bound to the request.
describe('t12-spike.sh requires all three launches and a bound run-enclave response', () => {
  const T = (id: string) => `nitro-cli terminate-enclave --enclave-id ${id}`;

  it.each([
    ['16', ['i-fake-18']],
    ['17', ['i-fake-16', 'i-fake-18']],
  ])('exits non-zero when run-enclave fails before starting CID %s, and cleans up only what it started', (cid, started) => {
    const { r, terminates } = runSpike({ FAIL_CID: cid });
    expect(r.status).not.toBe(0);
    expect(terminates.sort()).toEqual(started.map(T));
  });

  it('exits non-zero when fewer than three enclaves are listed at the end', () => {
    const { r } = runSpike({ DESCRIBE_RAW: '[]' });
    expect(r.status).not.toBe(0);
  });

  it('never passes a foreign id from a wrong-CID run-enclave response to terminate-enclave', () => {
    const { r, terminates } = runSpike({ WRONG_RESP_CID: '18' });
    expect(r.status).not.toBe(0);
    expect(terminates.join('\n')).not.toContain('i-seller-16');
    expect(terminates).toEqual([T('i-fake-18')]);
  });

  // Codex r4: cleanup read the response again with a CID-only check, so these reached terminate-enclave.
  it.each([
    ['the requested CID with a foreign id and name', { WRONG_NAME_CID: '18' }],
    ['two JSON documents', { TWO_DOCS_CID: '18' }],
  ])('never terminates a foreign id from a run-enclave response with %s', (_n, env) => {
    const { r, terminates } = runSpike(env);
    expect(r.status).not.toBe(0);
    expect(terminates.join('\n')).not.toContain('i-seller-18');
    expect(terminates).toEqual([T('i-fake-18')]);
  });
});

describe('t12-spike.sh signals', () => {
  // A real signal arrives while run-enclave 17 is still running (bash acts on it when the command returns). Optionally
  // further signals arrive while cleanup is terminating. Returns the exit code and what is left running.
  async function signalled(signals: NodeJS.Signals[], extra: NodeJS.Signals[]) {
    const sb = sandbox();
    fakeHost(sb.bin);
    writeFileSync(sb.state, '');
    writeFileSync(`${sb.state}.slowrun`, '17'); // the signal lands during run-enclave 17, so cleanup has 3 terminates to do
    const cwd = join(sb.dir, 'work');
    mkdirSync(cwd);
    const child = spawn('bash', [spike], {
      cwd,
      env: { PATH: `${sb.bin}:${process.env.PATH}`, LOG: sb.log, STATE: sb.state, SOCATPID: join(sb.dir, 'socat.pid') },
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && !existsSync(`${sb.state}.inrun`); i++) await sleep(50);
    for (const sig of signals) child.kill(sig);
    if (extra.length) {
      writeFileSync(`${sb.state}.slowterm`, '');
      await sleep(1500); // run-enclave returned at about 1 s; cleanup is now inside its slow terminate
      for (const sig of extra) child.kill(sig);
    }
    const code = await exited;
    const left = readFileSync(sb.state, 'utf8').split('\n').filter(Boolean);
    return { code, left, err };
  }

  it.each([['SIGINT'], ['SIGTERM']] as const)('a real %s mid-launch ends with the enclave terminated and status 130', async (sig) => {
    const { code, left } = await signalled([sig], []);
    expect(left).toEqual([]);
    expect(code).toBe(130);
  }, 20_000);

  it.each([
    ['SIGINT', 'SIGTERM'],
    ['SIGTERM', 'SIGINT'],
    ['SIGTERM', 'SIGTERM'],
  ] as const)('a %s followed by another %s during cleanup does not cut cleanup short', async (first, second) => {
    const { code, left, err } = await signalled([first], [second, second]);
    expect(left, err).toEqual([]);
    expect(code).toBe(130);
  }, 20_000);
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

  it('pins the exact digests, not just their shape', () => {
    expect(/^NODE_SHA256=(\S+)/m.exec(setup)?.[1]).toBe('fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8');
    // CADDY_SHA512 as it stood at HEAD 4bf3224, verified against the published file earlier
    expect(/^CADDY_SHA512=(\S+)/m.exec(setup)?.[1]).toBe(
      '6ce061a690312ab38367df3c5d5f89a2e4a263e7300d300d87356211bb81e79b15933e6d6203e03fbf26f15cc0311f264805f336147dbdd24938d84b57a4421c',
    );
  });

  it('downloads and verifies both archives before the first sudo, and checks its tools instead of installing them', () => {
    const code = setup.split('\n').filter((l) => !l.trimStart().startsWith('#'));
    const at = (re: RegExp, from = 0) => code.findIndex((l, i) => i >= from && re.test(l));
    const firstSudo = at(/\bsudo\b/);
    expect(firstSudo).toBeGreaterThan(0);
    expect(at(/^fetch_verified "https:\/\/nodejs\.org/)).toBeGreaterThan(0);
    expect(at(/^fetch_verified "https:\/\/nodejs\.org/)).toBeLessThan(firstSudo);
    expect(at(/^fetch_verified "https:\/\/github\.com/)).toBeLessThan(firstSudo);
    expect(at(/command -v/)).toBeLessThan(at(/^fetch_verified "https:\/\/nodejs\.org/));
    expect(at(/dnf install/)).toBeGreaterThan(at(/^fetch_verified "https:\/\/github\.com/));
  });

  it('stops with a clear message, installing nothing, when curl is missing', () => {
    const sb = sandbox();
    const tools = join(sb.dir, 'tools');
    mkdirSync(tools);
    for (const t of ['bash', 'id', 'mktemp', 'rm', 'cut', 'sha256sum', 'sha512sum']) {
      const p = spawnSync('command', ['-v', t], { shell: true, encoding: 'utf8' }).stdout.trim();
      writeFileSync(join(tools, t), `#!/bin/sh\nexec ${p} "$@"\n`);
      chmodSync(join(tools, t), 0o755);
    }
    fake(tools, 'uname', 'echo aarch64');
    fake(tools, 'sudo', 'echo "sudo $*" >> "$LOG"');
    const r = spawnSync('bash', [setupPath, 'a'.repeat(40)], { encoding: 'utf8', env: { PATH: tools, LOG: sb.log, HOME: sb.dir } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/missing: curl\. Nothing was installed/);
    expect(existsSync(sb.log)).toBe(false);
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
