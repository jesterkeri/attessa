import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Adversary round 8 for scripts/ec2-host-setup.sh (commit 4b1304a): "Safe to run again" while an enclave is running.
// Upstream fact (aws-nitro-enclaves-cli v1.4.0, bootstrap/nitro-enclaves-allocator, enable_offline_cpus, called from main()
// for a `cpu_count` config): restarting nitro-enclaves-allocator.service fails with "Could not re-online CPUs because there is
// at least one enclave currently running. Make sure you stop all enclaves prior to re-starting the nitro-enclaves-allocator.service."
// The fake systemctl below reproduces exactly that, and nothing else.
const setupPath = new URL('../../../scripts/ec2-host-setup.sh', import.meta.url).pathname;
const setup = readFileSync(setupPath, 'utf8');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function fake(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

describe('ec2-host-setup.sh re-run while a seller enclave is running', () => {
  it('either gets past the allocator step or refuses before changing the host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-adv8-'));
    dirs.push(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'sudo.log');
    writeFileSync(log, '');
    const node256 = /^NODE_SHA256=(\S+)/m.exec(setup)?.[1];
    const caddy512 = /^CADDY_SHA512=(\S+)/m.exec(setup)?.[1];
    expect(node256).toBeTruthy();
    expect(caddy512).toBeTruthy();
    fake(bin, 'uname', 'echo aarch64');
    fake(bin, 'curl', 'out=; while [ $# -gt 0 ]; do [ "$1" = -fsSLo ] && out=$2; shift; done; : > "$out"');
    fake(bin, 'sha256sum', `echo "${node256}  $1"`);
    fake(bin, 'sha512sum', `echo "${caddy512}  $1"`);
    // A host with one live enclave (the mainnet seller).
    fake(bin, 'nitro-cli', 'case "$1" in --version) echo "Nitro CLI 1.5.2" ;; describe-enclaves) echo \'[{"EnclaveID":"i-0123456789abcdef0-enc0123456789abcdef0","EnclaveCID":16}]\' ;; esac');
    fake(
      bin,
      'sudo',
      `echo "sudo $*" >> "$LOG"
[ "$1" != tee ] || cat >/dev/null
case "$*" in
  *"systemctl restart"*nitro-enclaves-allocator*)
    if [ "$(nitro-cli describe-enclaves | jq length)" != 0 ]; then
      echo "Could not re-online CPUs because there is at least one enclave currently running. Make sure you stop all enclaves prior to re-starting the nitro-enclaves-allocator.service." >&2
      exit 1
    fi ;;
esac
exit 0`,
    );
    const r = spawnSync('bash', [setupPath, 'a'.repeat(40)], {
      encoding: 'utf8',
      cwd: dir,
      env: { PATH: `${bin}:${process.env.PATH}`, LOG: log, HOME: dir },
    });
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const restartedAllocator = calls.some((c) => /systemctl restart.*nitro-enclaves-allocator/.test(c));
    const gotPast = calls.some((c) => /usermod/.test(c));
    const touchedHost = calls.length > 0;
    // Fix-agnostic: do not restart the allocator under a running enclave, or carry on past it, or refuse before any sudo.
    expect(
      !restartedAllocator || gotPast || !touchedHost,
      `status=${r.status}; the script restarted the allocator under a running enclave, died there and left the host half-updated.\nsudo calls:\n${calls.join('\n')}\nstderr: ${r.stderr}`,
    ).toBe(true);
    expect(existsSync(log)).toBe(true);
  });
});

describe('ec2-host-setup.sh allocator choices', () => {
  function run(enclaves: string, sameSettings: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-alloc-'));
    dirs.push(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'sudo.log');
    writeFileSync(log, '');
    fake(bin, 'uname', 'echo aarch64');
    fake(bin, 'curl', 'out=; while [ $# -gt 0 ]; do [ "$1" = -fsSLo ] && out=$2; shift; done; : > "$out"');
    fake(bin, 'sha256sum', `echo "${/^NODE_SHA256=(\S+)/m.exec(setup)?.[1]}  $1"`);
    fake(bin, 'sha512sum', `echo "${/^CADDY_SHA512=(\S+)/m.exec(setup)?.[1]}  $1"`);
    fake(bin, 'nitro-cli', `case "$1" in --version) echo 1.5.2 ;; describe-enclaves) ${enclaves} ;; esac`);
    fake(bin, 'cmp', sameSettings ? 'exit 0' : 'exit 1');
    fake(bin, 'sudo', 'echo "sudo $*" >> "$LOG"; [ "$1" != tee ] || cat >/dev/null; exit 0');
    const r = spawnSync('bash', [setupPath, 'a'.repeat(40)], { encoding: 'utf8', cwd: dir, env: { PATH: `${bin}:${process.env.PATH}`, LOG: log, HOME: dir } });
    return { r, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  }
  const running = `echo '[{"EnclaveCID":16}]'`;

  it('no enclave: writes the settings and restarts the allocator', () => {
    const { calls } = run(`echo '[]'`, false);
    expect(calls.some((c) => /tee .*allocator\.yaml/.test(c))).toBe(true);
    expect(calls.some((c) => /systemctl restart docker nitro-enclaves-allocator/.test(c))).toBe(true);
    expect(calls.some((c) => /usermod/.test(c))).toBe(true);
  });

  it('a host that can\'t answer yet (fresh install) counts as no enclave', () => {
    const { calls } = run('exit 1', false);
    expect(calls.some((c) => /systemctl restart docker nitro-enclaves-allocator/.test(c))).toBe(true);
  });

  it('an enclave running, same settings: leaves the allocator alone and carries on', () => {
    const { r, calls } = run(running, true);
    expect(calls.some((c) => /tee .*allocator\.yaml/.test(c))).toBe(false);
    expect(calls.some((c) => /systemctl restart.*nitro-enclaves-allocator/.test(c))).toBe(false);
    expect(calls.some((c) => /usermod/.test(c))).toBe(true);
    expect(r.stdout).toContain('not restarting the allocator');
  });

  it('an enclave running, different settings: stops and says so, allocator untouched', () => {
    const { r, calls } = run(running, false);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Stop them, then run this again');
    expect(calls.some((c) => /allocator/.test(c))).toBe(false);
  });
});
