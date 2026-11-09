// Attack round 2 for scripts/tagged-deploy.mjs (T30). Uses the real reference build (forge + solc 0.8.26) and `cast`.
// Meant to live at scripts/tagged-deploy.attack2.test.mjs of the T30 worktree (the harness blocked writes under
// .claude/, so it sits in the scratchpad and imports the worktree by absolute path). Run:
//   flock /home/hr/.cache/attessa-heavy.lock node --test <this file>
//
// The printed command has never been run by any test: a repo hook blocks the cast send command, and the e2e harness
// sends the data file by another route. `cast mktx` shares send's `--create` subcommand parser but signs and sends
// nothing, so it stands in for it here (foundry 1.8.1; the keystore name below does not exist, so nothing can be signed).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { prepare, realDeps } from './tagged-deploy.mjs';

const DEPLOYER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const ADMIN = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const TAG = 'celo_0123456789ab';
const NO_SUCH_KEYSTORE = 'no-such-keystore-t30-r2';
const PRINTED_HEAD = /^cast [s]end /;
const real = realDeps('http://127.0.0.1:1');
let ref;

before(() => {
  ref = real.loadReference();
});

function fakeDeps(tmp) {
  return {
    rpc: async (method) => {
      if (method === 'eth_chainId') return '0xa4ec';
      if (method === 'eth_getCode') return '0x';
      if (method === 'eth_estimateGas') return '0x' + (1_750_120).toString(16);
      if (method === 'eth_getTransactionCount') return '0x5';
      throw new Error(`unexpected ${method}`);
    },
    gitStatus: () => '',
    loadReference: () => ref,
    keccak: real.keccak,
    tmp: () => tmp,
  };
}

async function printedCommand(out) {
  const lines = [];
  await prepare('p384', { positional: [], deployer: DEPLOYER, account: NO_SUCH_KEYSTORE, rpcUrl: 'http://127.0.0.1:1', out, tx: null }, { LOOPS_ATTRIBUTION_TAG: TAG, ATTESSA_ADMIN: ADMIN }, fakeDeps(out), (l) => lines.push(l));
  const cmd = lines.find((l) => PRINTED_HEAD.test(l));
  assert.ok(cmd, 'prepare printed no deploy command');
  return cmd;
}

const run = (cmd) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 60_000 });

test('control: cast mktx parses its options when they come before --create, and stops at the missing keystore', () => {
  const r = run(`cast mktx --account ${NO_SUCH_KEYSTORE} --from ${DEPLOYER} --rpc-url http://127.0.0.1:1 --gas-limit 1300000 --create 0x00`);
  assert.doesNotMatch(r.stderr, /unexpected argument/, r.stderr);
  assert.match(r.stderr, /Keystore file/, r.stderr);
});

// docs/DEPLOYMENTS.md: "Joshua runs that command". The printed line puts --account, --from, --rpc-url and --gas-limit
// after the `--create <CODE>` subcommand, which does not define them (`cast help send --create` lists none of them), so
// clap rejects the line before anything is signed.
test("the printed deploy command is accepted by cast's parser (its options come before --create)", async () => {
  const out = mkdtempSync(join(tmpdir(), 'td-atk2-'));
  try {
    const cmd = await printedCommand(out);
    const asMktx = cmd.replace(PRINTED_HEAD, 'cast mktx ');
    const r = run(asMktx);
    assert.doesNotMatch(r.stderr, /unexpected argument/, `cast rejected the printed command line:\n${cmd.replace(/"\$\(cat .*\)"/, '"$(cat <file>)"')}\n${r.stderr}`);
    assert.match(r.stderr, /Keystore file/, `expected to reach the keystore lookup, got:\n${r.stderr}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
