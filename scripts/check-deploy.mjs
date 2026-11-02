#!/usr/bin/env node
// T10/T30 (SPEC §3.5): checks a deployed Attessa stack against docs/DEPLOYMENTS.md,
// packages/core/src/deployments.ts and a reference build of the production contracts.
// Read-only: eth_chainId, eth_getCode and eth_call only.
//
//   node scripts/check-deploy.mjs <network> [--rpc-url URL] [--deployments FILE] [--core FILE]
//   node scripts/check-deploy.mjs --pre-deploy
//
// --pre-deploy, before every deploy simulation and broadcast: refuses, before any forge command, a
// committed .env and a contracts/foundry.toml line outside a fixed list (T10 adversary r9), then
// requires forge's effective config in contracts/ to equal the reference build's and no
// FOUNDRY_*/DAPP_* variable, then runs `forge clean`
// and `forge build` there and requires the deploy scripts and production contracts in that out to
// equal the reference build (bytecode and runtime code, metadata included) and to be compiled only
// from committed blobs. A committed remapping, foundry.toml or source that swaps the in-script
// guard (T10 adversary r5 M, r6 D, r7 X, r8 O) fails here. Exit 0: PASS. 1: FAIL. 2: could not run.
//
// The reference bytecode is compiled fresh, in a temp dir, from HEAD's committed contracts/ and
// the nitro-validator commit HEAD pins. Nothing in the working tree (uncommitted edits,
// contracts/out, a dirty submodule) can change it, so run this from the commit that was deployed.
// Needs git and forge on PATH. Exit 0: every check printed OK. Exit 1: a check failed. Exit 2:
// could not run (bad input, TODO addresses, reference build failed, RPC error).

import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PINNED_VALIDATOR_COMMIT = '0ea0d12366b4fa44f9e07e4755f2ad36561cb674';
const DEFAULT_RPC = {
  'celo-sepolia': 'https://forno.celo-sepolia.celo-testnet.org',
  celo: 'https://forno.celo.org',
};
// SPEC §2.6 and §3.5, per network: the chain id and the identity and Self registries the
// EnclaveRegistry must embed. Fixed here, not read from deployments.ts or DEPLOYMENTS.md, so an
// edit to both of those cannot move them (T10 Codex r1 M1).
const PINS = {
  'celo-sepolia': {
    chainId: 11142220,
    identityRegistry: '0x8004a818bfb912233c491871b3d84c89a494bd9e',
    selfRegistry: '0x043dacac8b0771dd5b444bcc88f2f8bbdbedd379',
  },
  celo: {
    chainId: 42220,
    identityRegistry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
    selfRegistry: '0xac3df9abf80d0f5c020c06b04cced27763355944',
  },
};
const OURS = ['P384Verifier', 'CertManager', 'NitroValidator', 'EnclaveRegistry'];
// --pre-deploy also checks the deploy scripts; DeployBase.sol is in both scripts' metadata sources.
const SCRIPTS = ['DeployValidatorStack', 'DeployRegistry'];
// The source each reference artifact must be compiled from (its metadata compilationTarget), so a
// same-named contract elsewhere in the tree cannot stand in for it (T10 adversary r4 S).
const SOURCES = {
  P384Verifier: 'lib/nitro-validator/src/P384Verifier.sol',
  CertManager: 'lib/nitro-validator/src/CertManager.sol',
  NitroValidator: 'lib/nitro-validator/src/NitroValidator.sol',
  EnclaveRegistry: 'src/EnclaveRegistry.sol',
  DeployValidatorStack: 'script/DeployValidatorStack.s.sol',
  DeployRegistry: 'script/DeployRegistry.s.sol',
};
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
  if (!Object.hasOwn(PINS, args.network)) throw new Refuse(`no SPEC §3.5 pins for network ${args.network}; known: ${Object.keys(PINS).join(', ')}`);
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

/** The environment minus every variable whose prefix is in `drop`, plus `add`. */
function envWithout(drop, add = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!drop.some((p) => k.startsWith(p))) env[k] = v;
  return { ...env, ...add };
}
// No refs/replace objects (a local `git replace <pinned> <other>` would show <other>'s tree under
// the pinned id; T10 adversary r4 R) and no GIT_* variables (GIT_DIR, GIT_CONFIG_* and the like
// could point git elsewhere or reconfigure it).
const GIT_ENV = envWithout(['GIT_'], { GIT_NO_REPLACE_OBJECTS: '1' });
const gitRaw = (dir, a, opts = {}) => execFileSync('git', ['--no-replace-objects', '-C', dir, ...a], { env: GIT_ENV, ...opts });
const git = (dir, ...a) => gitRaw(dir, a, { encoding: 'utf8' }).trim();
// FOUNDRY_* and DAPP_* variables (e.g. FOUNDRY_OPTIMIZER_RUNS, FOUNDRY_PROFILE) are dropped.
const FORGE_ENV = envWithout(['FOUNDRY_', 'DAPP_']);
const SOLC_VERSION = '0.8.26';
// The production compiler settings, fixed here rather than read from the committed foundry.toml or
// remappings.txt: a remapping there can redirect the pinned sources' own relative imports, e.g.
// `lib/nitro-validator/src/LibBytes.sol=src/evil/LibBytes.sol` (T10 adversary r5 M). They must
// equal the committed ones, which the deploy scripts compile with, or no runtime code will match:
// solc records the remappings in the metadata hash. The forge-std remapping only matches imports
// starting `forge-std/`, which no production source has.
const REMAPPINGS = ['forge-std/=lib/nitro-validator/lib/forge-std/src/', 'nitro-validator/=lib/nitro-validator/src/'];
const foundryToml = (solc) => `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
optimizer = true
optimizer_runs = 10000
solc = ${JSON.stringify(solc)}
offline = true
auto_detect_remappings = false
remappings = ${JSON.stringify(REMAPPINGS)}
`;

/** The svm-installed solc binary forge would use; HOME is replaced for the build itself. */
function solcPath() {
  const home = homedir();
  const dirs = [join(home, '.svm'), process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, 'svm'), join(home, '.local', 'share', 'svm')];
  for (const d of dirs.filter(Boolean)) {
    const p = join(d, SOLC_VERSION, `solc-${SOLC_VERSION}`);
    if (existsSync(p)) return p;
  }
  throw new Refuse(`no solc ${SOLC_VERSION} under ~/.svm or ~/.local/share/svm; run \`cd contracts && forge build\` once to install it`);
}

// Hex on stdin, not argv: forge-std sources exceed the argument size limit.
const keccak = (buf) => execFileSync('cast', ['keccak'], { input: '0x' + buf.toString('hex'), env: FORGE_ENV, encoding: 'utf8' }).trim().toLowerCase();

/**
 * Writes the committed blobs under `paths` at `rev` into `dest`, byte for byte. Not `git archive`
 * or checkout: those apply committed .gitattributes (export-subst, export-ignore, filters), so the
 * build could see code that is not in the commit (T10 adversary r3). Only regular files allowed.
 */
function exportBlobs(repo, rev, paths, dest) {
  const written = {};
  const listing = gitRaw(repo, ['ls-tree', '-r', '-z', '--full-tree', rev, '--', ...paths], { encoding: 'utf8' });
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
    written[path] = gitRaw(repo, ['cat-file', 'blob', sha], { maxBuffer: 64 << 20 });
    writeFileSync(out, written[path]);
  }
  return written;
}

/**
 * Compiles the production contracts from HEAD's committed contracts/src plus the nitro-validator
 * commit HEAD records, in a fresh temp dir with `forge build --force`, under a generated
 * foundry.toml and an empty HOME (so no ~/.foundry/foundry.toml applies; T10 adversary r5 G).
 * With `withScripts`, also HEAD's contracts/script and the forge-std commit nitro-validator pins.
 * Returns the artifacts, the committed blob for each source path, and what they were built from.
 */
function referenceBuild(withScripts = false) {
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
    // Only what the production contracts (and, withScripts, the deploy scripts) compile from.
    const scriptFiles = ['script/DeployBase.sol', ...SCRIPTS.map((n) => SOURCES[n])].map((p) => `contracts/${p}`);
    const own = exportBlobs(ROOT, 'HEAD', ['contracts/src/EnclaveRegistry.sol', ...(withScripts ? scriptFiles : [])], dir);
    const nv = `${ROOT}/contracts/lib/nitro-validator`;
    const validator = exportBlobs(nv, pinned, ['src'], join(dir, 'contracts/lib/nitro-validator'));
    let forgeStd = {};
    if (withScripts) {
      const [, type, stdCommit] = git(nv, 'ls-tree', pinned, 'lib/forge-std').split(/\s+/);
      if (type !== 'commit') throw new Refuse(`nitro-validator ${pinned} does not record lib/forge-std as a submodule`);
      forgeStd = exportBlobs(`${nv}/lib/forge-std`, stdCommit, ['src'], join(dir, 'contracts/lib/nitro-validator/lib/forge-std'));
    }
    writeFileSync(join(dir, 'contracts', 'foundry.toml'), foundryToml(solcPath()));
    const home = join(dir, 'home');
    mkdirSync(home);
    // forge compiles src/ plus what it imports; the validator stack is named explicitly.
    const names = withScripts ? [...OURS, ...SCRIPTS] : OURS;
    const paths = ['src', ...['P384Verifier', 'CertManager', 'NitroValidator', ...(withScripts ? SCRIPTS : [])].map((n) => SOURCES[n])];
    const out = join(dir, 'contracts', 'out');
    // cwd is the temp dir too, so forge loads no .env from wherever check-deploy was started.
    execFileSync('forge', ['build', '--force', '--root', join(dir, 'contracts'), '--out', out, ...paths.map((p) => join(dir, 'contracts', p))], {
      cwd: dir,
      env: { ...FORGE_ENV, HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const arts = selectArtifacts(out, names);
    const blobs = {};
    for (const [p, buf] of Object.entries(validator)) blobs[`lib/nitro-validator/${p}`] = buf;
    for (const [p, buf] of Object.entries(forgeStd)) blobs[`lib/nitro-validator/lib/forge-std/${p}`] = buf;
    for (const [p, buf] of Object.entries(own)) blobs[p.replace(/^contracts\//, '')] = buf;
    const bad = sourceProblems(arts, names, blobs, 'reference');
    if (bad.length) throw new Refuse(bad[0]);
    return { arts, blobs, head, pinned };
  } catch (e) {
    if (e instanceof Refuse) throw e;
    throw new Refuse(`reference build failed: ${(e.stderr?.toString() || e.message).trim().split('\n').slice(-3).join(' | ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every source each artifact's metadata lists must be a committed blob, by path and by keccak256:
 * pinned nitro-validator source only for the validator stack, plus HEAD's src/EnclaveRegistry.sol
 * for EnclaveRegistry, plus HEAD's script/ and pinned forge-std for the deploy scripts.
 * Returns one message per problem.
 */
function sourceProblems(arts, names, blobs, label) {
  const problems = [];
  const allowedFor = (n, src) =>
    src.startsWith('lib/nitro-validator/src/') ||
    (src === 'src/EnclaveRegistry.sol' && (n === 'EnclaveRegistry' || SCRIPTS.includes(n))) ||
    (SCRIPTS.includes(n) && (src.startsWith('script/') || src.startsWith('lib/nitro-validator/lib/forge-std/src/')));
  for (const n of names) {
    if (Object.keys(arts[n].deployedBytecode.linkReferences ?? {}).length) problems.push(`${n} ${label} artifact has unlinked libraries`);
    for (const [src, { keccak256 }] of Object.entries(arts[n].metadata.sources)) {
      const buf = allowedFor(n, src) ? blobs[src] : undefined;
      if (!buf) problems.push(`${n} ${label} artifact compiled ${src}, which is not a committed source it may use`);
      else if (keccak(buf) !== keccak256.toLowerCase()) problems.push(`${n} ${label} artifact compiled ${src} with different content than the commit`);
    }
  }
  return problems;
}

/**
 * For each of `names`, the one artifact under `out` whose metadata compilationTarget is exactly
 * { SOURCES[n]: n }. Not out/<n>.sol/<n>.json: forge moves an artifact to out/<its path>/ when
 * another file of the same name declares the same contract, and puts the other one there.
 */
function selectArtifacts(out, names = OURS) {
  const found = Object.fromEntries(names.map((n) => [n, []]));
  for (const rel of readdirSync(out, { recursive: true })) {
    if (!rel.endsWith('.json') || rel.split(sep)[0] === 'build-info') continue;
    const art = JSON.parse(readFileSync(join(out, rel), 'utf8'));
    const target = Object.entries(art.metadata?.settings?.compilationTarget ?? {});
    if (target.length !== 1) continue;
    const [[src, name]] = target;
    if (Object.hasOwn(found, name) && src === SOURCES[name]) found[name].push({ rel, art });
  }
  const arts = {};
  for (const n of names) {
    if (found[n].length !== 1) {
      throw new Refuse(`${out} has ${found[n].length} artifacts compiled from ${SOURCES[n]}:${n}${found[n].length ? ` (${found[n].map((f) => f.rel).join(', ')})` : ''}`);
    }
    arts[n] = found[n][0].art;
  }
  return arts;
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

  const pin = PINS[args.network];
  check(`deployments.ts chainId == SPEC §2.6 pin ${pin.chainId}`, core.chainId === pin.chainId, `deployments.ts has ${core.chainId}`);
  const chainId = parseInt(await rpc(args.rpcUrl, 'eth_chainId', []), 16);
  check(`chain id ${pin.chainId}`, chainId === pin.chainId, `RPC reports ${chainId}`);

  // The cross-file checks stay; the code and getter checks below use the pins, never these values.
  const coreIdentity = String(core.identityRegistry).toLowerCase();
  const coreSelf = String(core.selfRegistry).toLowerCase();
  check('deployments.ts identityRegistry matches DEPLOYMENTS.md', coreIdentity === md.IdentityRegistry, `deployments.ts has ${coreIdentity}, DEPLOYMENTS.md has ${md.IdentityRegistry}`);
  check('deployments.ts selfRegistry matches DEPLOYMENTS.md', coreSelf === md.SelfRegistry, `deployments.ts has ${coreSelf}, DEPLOYMENTS.md has ${md.SelfRegistry}`);
  check(`deployments.ts identityRegistry == SPEC §3.5 pin ${pin.identityRegistry}`, coreIdentity === pin.identityRegistry, `deployments.ts has ${coreIdentity}`);
  check(`deployments.ts selfRegistry == SPEC §3.5 pin ${pin.selfRegistry}`, coreSelf === pin.selfRegistry, `deployments.ts has ${coreSelf}`);
  const identity = pin.identityRegistry;
  const self = pin.selfRegistry;
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

// Effective config keys allowed to differ from the reference build's: none changes what solc
// compiles or where forge reads artifacts. Remappings are compared as a sorted list instead.
const CONFIG_MAY_DIFFER = ['fs_permissions', 'offline', 'auto_detect_remappings', 'eth_rpc_url', 'etherscan_api_key'];
// Differences that still leave forge running only the pinned svm solc; the check then also builds,
// to report what that build would deploy. Any other difference (solc, vyper, ...) stops it first.
const CONFIG_SAFE_TO_BUILD = ['remappings', 'out', 'src', 'libs', 'optimizer', 'optimizer_runs', 'via_ir', 'evm_version', 'bytecode_hash', 'cbor_metadata'];

/** `forge config --json` at `root`: what forge build and forge script resolve there. Runs no compiler. */
function forgeConfig(root, env) {
  const c = JSON.parse(execFileSync('forge', ['config', '--json', '--root', root], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  c.remappings = [...(c.remappings ?? [])].sort();
  return c;
}

// Keys a contracts/foundry.toml line may set: the ones the config comparison below knows about.
const TOML_KEYS = [...CONFIG_SAFE_TO_BUILD, ...CONFIG_MAY_DIFFER, 'solc', 'solc_version'];

/**
 * What the committed tree must not contain before any forge command runs (T10 adversary r9).
 * forge loads `.env` from the project root and the cwd into its own environment, and every process
 * it starts, solc included, inherits it: one committed line (XDG_DATA_HOME to reach a committed
 * svm solc, LD_PRELOAD to load a committed library into the real one) runs committed code while
 * `forge config` shows nothing. So no tracked file, in HEAD or the index, may be named .env. And
 * forge, `forge config` included, runs a solc that foundry.toml names by path (`<path> --version`),
 * also through `extends`, an upper-case key or an escaped quoted key. So every contracts/foundry.toml
 * line must be blank, a comment, `[profile.default]` or `<key> = <value>` with a bare key from
 * TOML_KEYS, and solc/solc_version must be exactly "0.8.26". Returns one message per problem.
 */
function committedProblems(contracts) {
  const problems = [];
  let tracked;
  try {
    const list = (a) => gitRaw(ROOT, a, { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0');
    tracked = new Set([...list(['ls-files', '-z']), ...list(['ls-tree', '-r', '-z', '--name-only', 'HEAD'])]);
  } catch (e) {
    throw new Refuse(`cannot list the committed files at ${ROOT}: ${e.message.split('\n')[0]}`);
  }
  for (const p of tracked) {
    if (p.split('/').pop() === '.env') problems.push(`${p} is committed; forge loads it into its environment and every process it starts, unseen by forge config. Remove it from git`);
  }
  let toml;
  try {
    toml = readFileSync(join(contracts, 'foundry.toml'), 'utf8');
  } catch (e) {
    return [...problems, `contracts/foundry.toml cannot be read (${e.code})`];
  }
  toml.split('\n').forEach((line, i) => {
    const l = line.trim();
    if (l === '' || l.startsWith('#') || l === '[profile.default]') return;
    const m = /^([a-z_]+)\s*=\s*(.*)$/.exec(l);
    if (!m || !TOML_KEYS.includes(m[1])) {
      problems.push(`contracts/foundry.toml line ${i + 1} is not blank, a comment, [profile.default] or a key check-deploy knows; forge could run a solc it names`);
    } else if (m[1].startsWith('solc') && m[2] !== JSON.stringify(SOLC_VERSION)) {
      problems.push(`contracts/foundry.toml line ${i + 1} sets ${m[1]} to something other than "${SOLC_VERSION}"; forge runs a solc named by path, even for forge config`);
    }
  });
  return problems;
}

/**
 * --pre-deploy: what `forge script` from contracts/ will compile and run, against the reference
 * build. First, before any forge command: committedProblems(). Then, without compiling anything:
 * no FOUNDRY_* or DAPP_* variable, and the effective
 * config (foundry.toml and its profiles, remappings.txt, .env, ~/.foundry/foundry.toml) equal to the
 * reference build's but for CONFIG_MAY_DIFFER, so out, src, libs, solc (never a committed path),
 * remappings, optimizer, via_ir, evm_version and metadata settings all match (T10 adversary r8 O).
 * Then `forge clean` and `forge build`, so nothing stale is compared, and the artifacts in that out.
 * A config difference is a FAIL even when the artifacts match.
 */
function preDeploy() {
  const contracts = join(ROOT, 'contracts');
  const names = [...OURS, ...SCRIPTS];
  const report = (problems) => {
    for (const p of problems) console.log(`FAIL  ${p}`);
    console.log(problems.length ? 'FAIL: this checkout does not build the committed deploy; do not deploy from it' : `PASS: contracts/out equals the reference build for ${names.join(', ')}`);
    return problems.length ? 1 : 0;
  };
  // Names only, never values: they may hold secrets.
  const problems = Object.keys(process.env)
    .filter((k) => k.startsWith('FOUNDRY_') || k.startsWith('DAPP_'))
    .map((k) => `environment sets ${k}; DEPLOYMENTS.md sets no FOUNDRY_* or DAPP_* variable, unset it`);
  problems.push(...committedProblems(contracts));
  if (problems.length) return report(problems);
  const dir = mkdtempSync(join(tmpdir(), 'check-deploy-cfg-'));
  let want, got;
  try {
    mkdirSync(join(dir, 'home'));
    writeFileSync(join(dir, 'foundry.toml'), foundryToml(SOLC_VERSION));
    want = forgeConfig(dir, { ...FORGE_ENV, HOME: join(dir, 'home') });
    got = forgeConfig(contracts, process.env);
  } catch (e) {
    throw new Refuse(`forge config failed: ${(e.stderr?.toString() || e.message).trim().split('\n').slice(-3).join(' | ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const differ = [...new Set([...Object.keys(want), ...Object.keys(got)])].filter(
    (k) => !CONFIG_MAY_DIFFER.includes(k) && JSON.stringify(want[k]) !== JSON.stringify(got[k]),
  );
  for (const k of differ) problems.push(`forge config "${k}" in contracts/ differs from the reference build's`);
  if (differ.some((k) => !CONFIG_SAFE_TO_BUILD.includes(k))) return report(problems);

  const { arts: ref, blobs, head, pinned } = referenceBuild(true);
  console.log(`REF   reference build from HEAD ${head.slice(0, 12)} and nitro-validator ${pinned}`);
  try {
    for (const cmd of ['clean', 'build']) execFileSync('forge', [cmd], { cwd: contracts, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Refuse(`forge clean/build in contracts/ failed: ${(e.stderr?.toString() || e.message).trim().split('\n').slice(-3).join(' | ')}`);
  }
  let local;
  try {
    local = selectArtifacts(join(contracts, got.out), names);
  } catch (e) {
    if (!(e instanceof Refuse)) throw e;
    problems.push(e.message);
  }
  if (local) {
    problems.push(...sourceProblems(local, names, blobs, 'local'));
    for (const n of names) {
      for (const k of ['bytecode', 'deployedBytecode']) {
        if (local[n][k].object.toLowerCase() !== ref[n][k].object.toLowerCase()) problems.push(`${n} local ${k} differs from the reference build`);
      }
    }
  }
  return report(problems);
}

(process.argv[2] === '--pre-deploy' && process.argv.length === 3 ? Promise.resolve().then(preDeploy) : main()).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Refuse ? `check-deploy: ${e.message}` : e);
    process.exit(2);
  },
);
