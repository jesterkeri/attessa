#!/usr/bin/env node
// T10/T30 (SPEC §3.5): checks a deployed Attessa stack against docs/DEPLOYMENTS.md,
// packages/core/src/deployments.ts and a reference build of the production contracts.
// Read-only: eth_chainId, eth_getCode and eth_call only.
//
//   node scripts/check-deploy.mjs <network> [--rpc-url URL] [--deployments FILE] [--core FILE]
//
// The reference bytecode is compiled fresh, in a temp dir, from HEAD's committed contracts/ and
// the nitro-validator commit HEAD pins. Nothing in the working tree (uncommitted edits,
// contracts/out, a dirty submodule) can change it, so run this from the commit that was deployed.
// Needs git and forge on PATH. Exit 0: every check printed OK. Exit 1: a check failed. Exit 2:
// could not run (bad input, TODO addresses, reference build failed, RPC error).

import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PINNED_VALIDATOR_COMMIT = '0ea0d12366b4fa44f9e07e4755f2ad36561cb674';
const DEFAULT_RPC = {
  'celo-sepolia': 'https://forno.celo-sepolia.celo-testnet.org',
  celo: 'https://forno.celo.org',
};
const OURS = ['P384Verifier', 'CertManager', 'NitroValidator', 'EnclaveRegistry'];
// Each contract's immutables in declaration order. Solidity numbers AST ids in source order, so
// sorting an artifact's immutableReferences ids gives the same order.
const IMMUTABLES = {
  P384Verifier: [],
  CertManager: ['p384Verifier'],
  NitroValidator: ['certManager', 'p384Verifier'],
  EnclaveRegistry: ['identityRegistry', 'nitroValidator', 'selfRegistry', 'allowLocalOrigins'],
};

class Refuse extends Error {}

function parseArgs(argv) {
  const args = { network: null, rpcUrl: null, deployments: null, core: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Refuse(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--rpc-url') args.rpcUrl = val();
    else if (a === '--deployments') args.deployments = val();
    else if (a === '--core') args.core = val();
    else if (a.startsWith('-')) throw new Refuse(`unknown option ${a}`);
    else if (args.network === null) args.network = a;
    else throw new Refuse(`unexpected argument ${a}`);
  }
  if (!args.network) throw new Refuse('usage: node scripts/check-deploy.mjs <network> [--rpc-url URL] [--deployments FILE] [--core FILE]');
  args.rpcUrl ??= DEFAULT_RPC[args.network];
  if (!args.rpcUrl) throw new Refuse(`no default RPC for network ${args.network}; pass --rpc-url`);
  args.deployments = resolve(args.deployments ?? `${ROOT}/docs/DEPLOYMENTS.md`);
  args.core = resolve(args.core ?? `${ROOT}/packages/core/src/deployments.ts`);
  return args;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The `| Name | `value` |` rows under `## <network>` in DEPLOYMENTS.md. */
function parseDeploymentsMd(text, network) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${network}` || l.startsWith(`## ${network} `));
  if (start < 0) throw new Refuse(`no "## ${network}" section in DEPLOYMENTS.md`);
  const rows = {};
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) {
    // The name is the first word: `| IdentityRegistry (ERC-8004) | ...` is IdentityRegistry.
    const m = /^\|\s*([A-Za-z0-9]+)[^|`]*\|\s*`([^`]*)`\s*\|/.exec(lines[i]);
    if (!m) continue;
    if (m[1] in rows) throw new Refuse(`DEPLOYMENTS.md ${network}: ${m[1]} row appears twice`);
    rows[m[1]] = m[2].trim();
  }
  const out = {};
  for (const name of ['Admin', ...OURS, 'IdentityRegistry', 'SelfRegistry']) {
    const v = rows[name];
    if (v === undefined) throw new Refuse(`DEPLOYMENTS.md ${network}: no ${name} row`);
    if (/^TODO/i.test(v)) {
      throw new Refuse(`DEPLOYMENTS.md ${network}: ${name} is still "${v}". Not deployed yet: Joshua broadcasts per "How to deploy", then fills in the addresses.`);
    }
    if (!ADDRESS_RE.test(v)) throw new Refuse(`DEPLOYMENTS.md ${network}: ${name} is not an address: "${v}"`);
    if (/^0x0{40}$/.test(v)) throw new Refuse(`DEPLOYMENTS.md ${network}: ${name} is the zero address`);
    out[name] = v.toLowerCase();
  }
  return out;
}

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

/**
 * Writes the committed blobs under `paths` at `rev` into `dest`, byte for byte. Not `git archive`
 * or checkout: those apply committed .gitattributes (export-subst, export-ignore, filters), so the
 * build could see code that is not in the commit (T10 adversary r3). Only regular files allowed.
 */
function exportBlobs(repo, rev, paths, dest) {
  const listing = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '-z', '--full-tree', rev, '--', ...paths], { encoding: 'utf8' });
  const entries = listing.split('\0').filter(Boolean);
  if (entries.length === 0) throw new Refuse(`${repo} has nothing at ${paths.join(', ')} in ${rev}`);
  for (const entry of entries) {
    const [meta, path] = entry.split('\t');
    const [mode, type, sha] = meta.split(' ');
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      throw new Refuse(`${repo} ${rev}: ${path} is a ${type} with mode ${mode}; only regular files are built`);
    }
    const out = join(dest, path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, execFileSync('git', ['-C', repo, 'cat-file', 'blob', sha], { maxBuffer: 64 << 20 }));
  }
}

/**
 * Compiles the production contracts from HEAD's committed contracts/ (foundry.toml and
 * remappings included) plus the nitro-validator commit HEAD records, in a fresh temp dir with
 * `forge build --force`. Returns the artifacts and what they were built from.
 */
function referenceBuild() {
  let head, gitlink;
  try {
    head = git(ROOT, 'rev-parse', 'HEAD');
    gitlink = git(ROOT, 'ls-tree', 'HEAD', 'contracts/lib/nitro-validator').split(/\s+/);
  } catch (e) {
    throw new Refuse(`cannot read the committed tree at ${ROOT}: ${e.message.split('\n')[0]}`);
  }
  if (gitlink[1] !== 'commit') throw new Refuse('HEAD does not record contracts/lib/nitro-validator as a submodule');
  const pinned = gitlink[2];
  // The full id: a 7-hex prefix is 28 bits and a colliding commit takes seconds (T10 adversary r3).
  if (pinned !== PINNED_VALIDATOR_COMMIT) {
    throw new Refuse(`HEAD pins nitro-validator at ${pinned}, not ${PINNED_VALIDATOR_COMMIT} (ADR-001)`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'check-deploy-ref-'));
  try {
    // Only what the production contracts compile from: no test/ or script/ (they need forge-std).
    exportBlobs(ROOT, 'HEAD', ['contracts/src', 'contracts/foundry.toml', 'contracts/remappings.txt'], dir);
    exportBlobs(`${ROOT}/contracts/lib/nitro-validator`, pinned, ['src'], join(dir, 'contracts/lib/nitro-validator'));
    // forge compiles src/ plus what it imports; the validator stack is named explicitly.
    const paths = ['src', ...['P384Verifier', 'CertManager', 'NitroValidator'].map((n) => `lib/nitro-validator/src/${n}.sol`)];
    execFileSync('forge', ['build', '--force', '--root', join(dir, 'contracts'), ...paths.map((p) => join(dir, 'contracts', p))], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const arts = {};
    for (const n of OURS) {
      const p = join(dir, `contracts/out/${n}.sol/${n}.json`);
      if (!existsSync(p)) throw new Refuse(`reference build produced no ${n} artifact`);
      arts[n] = JSON.parse(readFileSync(p, 'utf8'));
      if (Object.keys(arts[n].deployedBytecode.linkReferences ?? {}).length) throw new Refuse(`${n} artifact has unlinked libraries`);
    }
    return { arts, head, pinned };
  } catch (e) {
    if (e instanceof Refuse) throw e;
    throw new Refuse(`reference build failed: ${(e.stderr?.toString() || e.message).trim().split('\n').slice(-3).join(' | ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const word = (addrOrBool) =>
  typeof addrOrBool === 'boolean' ? (addrOrBool ? '1' : '0').padStart(64, '0') : addrOrBool.slice(2).toLowerCase().padStart(64, '0');

/**
 * The artifact's deployedBytecode with `values[name]` spliced into every immutableReferences
 * offset. Throws Refuse if the artifact's immutables don't match IMMUTABLES[name].
 */
function expectedRuntime(art, name, values) {
  let hex = art.deployedBytecode.object.replace(/^0x/, '').toLowerCase();
  const refs = art.deployedBytecode.immutableReferences ?? {};
  const ids = Object.keys(refs).map(Number).sort((a, b) => a - b);
  const names = IMMUTABLES[name];
  if (ids.length !== names.length) {
    throw new Refuse(`${name} artifact has ${ids.length} immutables, check-deploy expects ${names.length} (${names.join(', ')})`);
  }
  ids.forEach((id, i) => {
    const w = word(values[names[i]]);
    for (const { start, length } of refs[id]) {
      if (length !== 32) throw new Refuse(`${name} immutable ${names[i]} has length ${length}`);
      hex = hex.slice(0, start * 2) + w + hex.slice((start + length) * 2);
    }
  });
  return '0x' + hex;
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 2; i < n; i += 2) if (a.slice(i, i + 2) !== b.slice(i, i + 2)) return (i - 2) / 2;
  return a.length === b.length ? -1 : (n - 2) / 2;
}

async function rpc(url, method, params) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Refuse(`RPC ${url} ${method}: ${e.cause?.message ?? e.message}`);
  }
  if (!res.ok) throw new Refuse(`RPC ${url} ${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Refuse(`RPC ${method}: ${body.error.message}`);
  return body.result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const md = parseDeploymentsMd(readFileSync(args.deployments, 'utf8'), args.network);

  const { DEPLOYMENTS } = await import(pathToFileURL(args.core).href);
  const core = DEPLOYMENTS[args.network];
  if (!core) throw new Refuse(`${args.core} has no "${args.network}" entry`);

  const { arts, head, pinned } = referenceBuild();
  const sel = (n, sig) => {
    const s = arts[n].methodIdentifiers[sig];
    if (!s) throw new Refuse(`${n} artifact has no ${sig}`);
    return '0x' + s;
  };

  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(ok ? `OK    ${name}` : `FAIL  ${name}: ${detail}`);
  };
  // A revert is a failed check, not a refusal: a mock or foreign contract may lack the getter.
  const call = async (to, n, sig) =>
    rpc(args.rpcUrl, 'eth_call', [{ to, data: sel(n, sig) }, 'latest']).catch((e) => {
      if (e instanceof Refuse && e.message.startsWith('RPC eth_call:')) return `(reverted: ${e.message.slice(14)})`;
      throw e;
    });
  const callAddr = async (to, n, sig) => {
    const r = await call(to, n, sig);
    if (r.startsWith('(')) return r;
    return r.length === 66 ? '0x' + r.slice(26).toLowerCase() : `(bad return ${r})`;
  };

  // Printed, not a check: the reference build either ran from the committed tree or refused.
  console.log(`REF   reference bytecode compiled from HEAD ${head.slice(0, 12)} and nitro-validator ${pinned}`);

  check(
    'deployments.ts EnclaveRegistry matches DEPLOYMENTS.md',
    (core.enclaveRegistry ?? '').toLowerCase() === md.EnclaveRegistry,
    `deployments.ts has ${core.enclaveRegistry}, DEPLOYMENTS.md has ${md.EnclaveRegistry}`,
  );
  for (const [key, name] of [['p384Verifier', 'P384Verifier'], ['certManager', 'CertManager'], ['nitroValidator', 'NitroValidator']]) {
    const v = core.validatorStack?.[key];
    check(`deployments.ts ${name} matches DEPLOYMENTS.md`, (v ?? '').toLowerCase() === md[name], `deployments.ts has ${v}, DEPLOYMENTS.md has ${md[name]}`);
  }

  const chainId = parseInt(await rpc(args.rpcUrl, 'eth_chainId', []), 16);
  check(`chain id ${core.chainId}`, chainId === core.chainId, `RPC reports ${chainId}`);

  const identity = core.identityRegistry.toLowerCase();
  const self = core.selfRegistry.toLowerCase();
  check('deployments.ts identityRegistry matches DEPLOYMENTS.md', identity === md.IdentityRegistry, `deployments.ts has ${identity}, DEPLOYMENTS.md has ${md.IdentityRegistry}`);
  check('deployments.ts selfRegistry matches DEPLOYMENTS.md', self === md.SelfRegistry, `deployments.ts has ${self}, DEPLOYMENTS.md has ${md.SelfRegistry}`);
  const values = {
    P384Verifier: {},
    CertManager: { p384Verifier: md.P384Verifier },
    NitroValidator: { certManager: md.CertManager, p384Verifier: md.P384Verifier },
    EnclaveRegistry: { identityRegistry: identity, nitroValidator: md.NitroValidator, selfRegistry: self, allowLocalOrigins: false },
  };
  for (const n of OURS) {
    const code = (await rpc(args.rpcUrl, 'eth_getCode', [md[n], 'latest'])).toLowerCase();
    check(`${n} ${md[n]} has code`, code !== '0x', 'no code at this address');
    if (code === '0x') continue;
    const want = expectedRuntime(arts[n], n, values[n]);
    const at = firstDiff(code, want);
    check(
      `${n} runtime code equals the production artifact with immutables spliced`,
      at === -1,
      `${(code.length - 2) / 2} bytes deployed vs ${(want.length - 2) / 2} expected, first difference at byte ${at}`,
    );
  }

  const wiring = [
    ['CertManager', 'p384Verifier()', md.P384Verifier],
    ['NitroValidator', 'certManager()', md.CertManager],
    ['NitroValidator', 'p384Verifier()', md.P384Verifier],
    ['EnclaveRegistry', 'nitroValidator()', md.NitroValidator],
    ['EnclaveRegistry', 'identityRegistry()', identity],
    ['EnclaveRegistry', 'selfRegistry()', self],
    ['CertManager', 'owner()', md.Admin],
    ['CertManager', 'revoker()', md.Admin],
  ];
  for (const [n, sig, want] of wiring) {
    const got = await callAddr(md[n], n, sig);
    check(`${n}.${sig} == ${want}`, got === want, `got ${got}`);
  }
  const local = await call(md.EnclaveRegistry, 'EnclaveRegistry', 'allowLocalOrigins()');
  check('EnclaveRegistry.allowLocalOrigins() == false', local === '0x' + word(false), `got ${local}`);

  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `FAILED: ${failed} of ${results.length} checks failed` : `OK: all ${results.length} checks passed`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Refuse ? `check-deploy: ${e.message}` : e);
    process.exit(2);
  },
);
