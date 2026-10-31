// T10 fix 9: what a commit can make forge execute before the pre-deploy check compares anything.
//   flock /home/hr/.cache/attessa-heavy.lock node --test scripts/check-deploy.committed-config.test.mjs
// Needs forge, cast, git, gcc and node on PATH and solc 0.8.26 installed by svm. No RPC, no
// transaction: forge in a scratch mirror only.
//
// H. A committed contracts/.env is loaded by forge into its own environment, and every process forge
//    starts inherits it. Round 9 used XDG_DATA_HOME; LD_PRELOAD=/proc/self/cwd/tools/x.so loads a
//    committed shared object into the real svm solc (dynamically linked) on every compile, while
//    `forge config` is unchanged. (HOME set there does not move svm: probed with forge 1.8.1.)
//    The check refuses any committed .env, whatever it sets.
// P. `forge config` itself runs a solc that foundry.toml names by path (`<path> --version`), before
//    the check can compare that path with "0.8.26". Also through `extends` (another committed toml),
//    an upper-case key and a quoted key with an escape, all of which forge 1.8.1 honours.
// Each committed "solc" logs its arguments and forwards to the real one. None may ever run.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(ROOT, 'contracts');
const PINNED_FULL = '0ea0d12366b4fa44f9e07e4755f2ad36561cb674';
const REAL_SOLC = [join(homedir(), '.svm'), process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, 'svm'), join(homedir(), '.local', 'share', 'svm')]
  .filter(Boolean)
  .map((d) => join(d, '0.8.26', 'solc-0.8.26'))
  .find((p) => existsSync(p));

const tmp = mkdtempSync(join(tmpdir(), 'check-deploy-cfg9-'));
const M = join(tmp, 'mirror');
const MC = join(M, 'contracts');
const NV = join(MC, 'lib', 'nitro-validator');
const LOG = join(tmp, 'solc-calls.log');
const TOML = readFileSync(join(CONTRACTS, 'foundry.toml'), 'utf8');

const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const gitId = ['-c', 'user.email=test@test', '-c', 'user.name=test', '-c', 'commit.gpgsign=false'];
const PRELOAD = join(tmp, 'x.so');
// The committed "solc": logs its arguments, then runs the real one.
const fakeSolc = () => `#!/bin/sh\necho "$*" >> ${JSON.stringify(LOG)}\nexec ${JSON.stringify(REAL_SOLC)} "$@"\n`;

/** Commits `files` (path -> content; null removes) on top of the clean mirror, runs --pre-deploy, resets. */
function attempt(label, files) {
  const base = gitIn(M, 'rev-parse', 'HEAD');
  for (const [p, content] of Object.entries(files)) {
    const f = join(M, p);
    if (content === null) rmSync(f);
    else {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, content);
      if (p.includes('solc')) chmodSync(f, 0o755);
    }
  }
  gitIn(M, 'add', '-A');
  for (const p of Object.keys(files)) if (basename(p) === '.env') gitIn(M, 'add', '-f', p);
  gitIn(M, ...gitId, 'commit', '--quiet', '-m', label);
  const tracked = gitIn(M, 'ls-files', ...Object.keys(files));
  const clean = gitIn(M, 'status', '--porcelain');
  rmSync(LOG, { force: true });
  const r = spawnSync('node', [join(M, 'scripts', 'check-deploy.mjs'), '--pre-deploy'], { cwd: MC, encoding: 'utf8' });
  process.stdout.write(`--- --pre-deploy, ${label} (exit ${r.status})\n${r.stdout}${r.stderr}`);
  const calls = existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : [];
  gitIn(M, 'reset', '--quiet', '--hard', base);
  gitIn(M, 'clean', '--quiet', '-fdx', '--', 'contracts/tools');
  return { status: r.status, out: r.stdout + r.stderr, calls, tracked, clean };
}

before(() => {
  assert.ok(REAL_SOLC, 'no svm solc 0.8.26 installed');
  const c = join(tmp, 'x.c');
  writeFileSync(c, `#include <stdio.h>\n__attribute__((constructor)) static void c(void) { FILE *f = fopen(${JSON.stringify(LOG)}, "a"); if (f) { fputs("preload\\n", f); fclose(f); } }\n`);
  execFileSync('gcc', ['-shared', '-fPIC', '-o', PRELOAD, c]);
  mkdirSync(join(M, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'check-deploy.mjs'), join(M, 'scripts', 'check-deploy.mjs'));
  cpSync(join(ROOT, '.gitignore'), join(M, '.gitignore'));
  cpSync(CONTRACTS, MC, { recursive: true, filter: (p) => !['out', 'cache', 'broadcast', 'lib'].includes(basename(p)) || dirname(p) !== CONTRACTS });
  execFileSync('git', ['clone', '--quiet', '--no-checkout', join(CONTRACTS, 'lib', 'nitro-validator'), NV]);
  gitIn(NV, 'checkout', '--quiet', '--detach', PINNED_FULL);
  const FS = join(NV, 'lib', 'forge-std');
  execFileSync('git', ['clone', '--quiet', '--no-checkout', join(CONTRACTS, 'lib', 'nitro-validator', 'lib', 'forge-std'), FS]);
  gitIn(FS, 'checkout', '--quiet', '--detach', gitIn(NV, 'ls-tree', 'HEAD', 'lib/forge-std').split(/\s+/)[2]);
  gitIn(M, 'init', '--quiet');
  gitIn(M, 'add', '-A');
  gitIn(M, ...gitId, 'commit', '--quiet', '-m', 'mirror at the real pin');
});

after(() => {
  if (!process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
});

const refused = (r, why) => {
  assert.equal(r.clean, '', 'the attack commit left the tree dirty');
  assert.deepEqual(r.calls, [], `committed code ran during --pre-deploy: ${r.calls.join(' | ')}`);
  assert.equal(r.status, 1, 'the pre-deploy check did not FAIL');
  assert.match(r.out, why);
  assert.match(r.out, /^FAIL: /m);
};

test('H. committed contracts/.env with LD_PRELOAD of a committed shared object: FAIL before any forge command', () => {
  const r = attempt('H', {
    'contracts/.env': 'LD_PRELOAD=/proc/self/cwd/tools/x.so\n',
    'contracts/tools/x.so': readFileSync(PRELOAD),
  });
  assert.equal(r.tracked.split('\n').length, 2);
  refused(r, /contracts\/\.env is committed/);
});

test('H2. a committed .env at the repo root is refused too', () => {
  refused(attempt('H2', { '.env': 'LD_PRELOAD=/proc/self/cwd/tools/x.so\n', 'contracts/tools/x.so': readFileSync(PRELOAD) }), /^FAIL {2}\.env is committed/m);
});

for (const [name, toml] of [
  ['solc path', TOML.replace('solc_version = "0.8.26"', 'solc = "./tools/solc"')],
  ['upper-case SOLC key', TOML.replace('solc_version = "0.8.26"', 'SOLC = "./tools/solc"')],
  ['quoted key with an escape', TOML.replace('solc_version = "0.8.26"', '"\\u0073olc" = "./tools/solc"')],
  ['extends another committed toml', TOML.replace('solc_version = "0.8.26"', 'extends = "tools/base.toml"')],
]) {
  test(`P. contracts/foundry.toml, ${name}: forge config must not run the committed solc; FAIL`, () => {
    const r = attempt(`P ${name}`, {
      'contracts/foundry.toml': toml,
      'contracts/tools/solc': fakeSolc(),
      'contracts/tools/base.toml': '[profile.default]\nsolc = "./tools/solc"\n',
    });
    refused(r, /contracts\/foundry\.toml line \d+/);
  });
}
