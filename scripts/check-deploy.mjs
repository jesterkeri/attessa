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
// The source each reference artifact must be compiled from (its metadata compilationTarget), so a
// same-named contract elsewhere in the tree cannot stand in for it (T10 adversary r4 S).
const SOURCES = {
  P384Verifier: 'lib/nitro-validator/src/P384Verifier.sol',
  CertManager: 'lib/nitro-validator/src/CertManager.sol',
  NitroValidator: 'lib/nitro-validator/src/NitroValidator.sol',
  EnclaveRegistry: 'src/EnclaveRegistry.sol',
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

const keccak = (buf) => execFileSync('cast', ['keccak', '0x' + buf.toString('hex')], { env: FORGE_ENV, encoding: 'utf8' }).trim().toLowerCase();

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
 * Returns the artifacts and what they were built from.
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
    const own = exportBlobs(ROOT, 'HEAD', ['contracts/src/EnclaveRegistry.sol'], dir);
    const validator = exportBlobs(`${ROOT}/contracts/lib/nitro-validator`, pinned, ['src'], join(dir, 'contracts/lib/nitro-validator'));
    writeFileSync(join(dir, 'contracts', 'foundry.toml'), foundryToml(solcPath()));
    const home = join(dir, 'home');
    mkdirSync(home);
    // forge compiles src/ plus what it imports; the validator stack is named explicitly.
    const paths = ['src', ...['P384Verifier', 'CertManager', 'NitroValidator'].map((n) => SOURCES[n])];
    const out = join(dir, 'contracts', 'out');
    // cwd is the temp dir too, so forge loads no .env from wherever check-deploy was started.
    execFileSync('forge', ['build', '--force', '--root', join(dir, 'contracts'), '--out', out, ...paths.map((p) => join(dir, 'contracts', p))], {
      cwd: dir,
      env: { ...FORGE_ENV, HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const arts = selectArtifacts(out);
    // Every source solc compiled must be a pinned nitro-validator blob or, for EnclaveRegistry,
    // HEAD's EnclaveRegistry.sol, by path and by content.
    const allowed = {};
    for (const [p, buf] of Object.entries(validator)) allowed[`lib/nitro-validator/${p}`] = buf;
    for (const n of OURS) {
      if (Object.keys(arts[n].deployedBytecode.linkReferences ?? {}).length) throw new Refuse(`${n} artifact has unlinked libraries`);
      for (const [src, { keccak256 }] of Object.entries(arts[n].metadata.sources)) {
        const buf = src === 'src/EnclaveRegistry.sol' && n === 'EnclaveRegistry' ? own['contracts/src/EnclaveRegistry.sol'] : allowed[src];
        if (!buf) throw new Refuse(`${n} reference artifact compiled ${src}, which is neither pinned nitro-validator source nor src/EnclaveRegistry.sol`);
        if (keccak(buf) !== keccak256.toLowerCase()) throw new Refuse(`${n} reference artifact compiled ${src} with different content than the commit`);
      }
    }
    return { arts, head, pinned };
  } catch (e) {
    if (e instanceof Refuse) throw e;
    throw new Refuse(`reference build failed: ${(e.stderr?.toString() || e.message).trim().split('\n').slice(-3).join(' | ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * For each of OURS, the one artifact under `out` whose metadata compilationTarget is exactly
 * { SOURCES[n]: n }. Not out/<n>.sol/<n>.json: forge moves an artifact to out/<its path>/ when
 * another file of the same name declares the same contract, and puts the other one there.
 */
function selectArtifacts(out) {
  const found = Object.fromEntries(OURS.map((n) => [n, []]));
  for (const rel of readdirSync(out, { recursive: true })) {
    if (!rel.endsWith('.json') || rel.split(sep)[0] === 'build-info') continue;
    const art = JSON.parse(readFileSync(join(out, rel), 'utf8'));
    const target = Object.entries(art.metadata?.settings?.compilationTarget ?? {});
    if (target.length !== 1) continue;
    const [[src, name]] = target;
    if (Object.hasOwn(found, name) && src === SOURCES[name]) found[name].push({ rel, art });
  }
  const arts = {};
  for (const n of OURS) {
    if (found[n].length !== 1) {
      throw new Refuse(`reference build has ${found[n].length} artifacts compiled from ${SOURCES[n]}:${n}${found[n].length ? ` (${found[n].map((f) => f.rel).join(', ')})` : ''}`);
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

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Refuse ? `check-deploy: ${e.message}` : e);
    process.exit(2);
  },
);
