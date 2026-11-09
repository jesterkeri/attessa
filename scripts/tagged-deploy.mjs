#!/usr/bin/env node
// T30 (SPEC §3.5): the Celo mainnet deploy route whose creation transactions carry the Loops
// ERC-8021 attribution tag. `forge script` cannot append bytes to a creation transaction, so each
// of the four creations is a `cast send --create` of
//
//   creation bytecode (the pinned reference build) ++ abi.encode(constructor args) ++ suffix
//
// This script SIGNS NOTHING, READS NO KEY AND SENDS NOTHING. It checks, writes the exact creation
// data to a file, asks the RPC for a gas estimate (eth_estimateGas, read-only) and prints the
// command for Joshua to run. The key comes only from his Foundry keystore (`--account`).
//
//   node scripts/tagged-deploy.mjs <step> --deployer 0x.. --account <keystore-name> [--rpc-url URL] [--out DIR]
//   node scripts/tagged-deploy.mjs check <step> <address> --deployer 0x.. [--rpc-url URL] [--tx 0x<hash>]
//
// step: p384 | certmanager | nitro | registry, in that order. Environment (public values only):
//   LOOPS_ATTRIBUTION_TAG   the code Loops issued, 1 to 32 characters of a-z 0-9 _. It is public once a
//                           creation is mined, and the printed suffix contains it; an error message never
//                           shows it, valid or not.
//   ATTESSA_ADMIN           the cold admin EOA (not the deployer)
//   ATTESSA_P384_VERIFIER   certmanager and nitro steps: the P384Verifier from step 1
//   ATTESSA_CERT_MANAGER    nitro step: the CertManager from step 2
//   ATTESSA_NITRO_VALIDATOR registry step: the NitroValidator from step 3
// The identity and Self registries are pinned below for chain 42220 and never read from env.
//
// `check` is each step's post-check: the deployed runtime code equals the reference with the
// deployed values spliced in, the wiring reads back, and with --tx the creation input is exactly
// reference creation bytecode ++ constructor args ++ suffix, rebuilt from the repo and the env with no
// data file needed (so it ends in the suffix).
//
// What is pinned (see docs/DEPLOYMENTS.md): before anything is printed, `prepare` and `check` require
// the reference build to match, for all four contracts, the keccak256 of its whole creation bytecode
// (CREATION_PINNED: constructor code, runtime code, metadata trailer; so solc, evm_version and sources)
// and the keccak256 of the runtime code embedded in it with immutables zeroed (PINNED). The
// P384Verifier, CertManager and NitroValidator runtime pins are the constants of DeployBase.sol;
// EnclaveRegistry's runtime and creation pins, and all four creation pins, exist only here and are
// recorded from the reference build at the reviewed commit. They must be re-recorded, in the same
// commit, whenever EnclaveRegistry.sol or the pinned nitro-validator changes.
//
// Exit 0: done. 1: refused (nothing written). 2: usage.

import { existsSync, mkdirSync, chmodSync, lstatSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute, dirname, basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, PINS, Refuse, referenceBuild, expectedRuntime, firstDiff, rpc as rawRpc, keccak, word } from './check-deploy.mjs';
import { attributionSuffix } from '../packages/core/src/attribution.ts';

export const CHAIN_ID = 42220;
export const GAS_CAP = 16_777_216;
export const DEFAULT_RPC = 'https://forno.celo.org';
export const STEPS = ['p384', 'certmanager', 'nitro', 'registry'];
const CONTRACT = { p384: 'P384Verifier', certmanager: 'CertManager', nitro: 'NitroValidator', registry: 'EnclaveRegistry' };
// The whole runtime code of each production contract, every immutable's 32-byte word zeroed:
// the constants in contracts/script/DeployBase.sol (a test keeps the two equal).
export const PINNED = {
  P384Verifier: '0x8fd030adc83776191eb6bd006135f34e1ad114d8c6cd5cbb8fb5ce3860cdca3d',
  CertManager: '0x5246ebbad7caa8df452b1f7adbc95883e08e1b0e4bbc64cda7e4c8624ecc224d',
  NitroValidator: '0xe45bfed4f16e6fdbd5fc5c039901754029e7b75b0c95d0de248a70eaa223a914',
  // Not in DeployBase.sol (the registry is not part of the validator-stack check): recorded from the
  // reference build of this repo's contracts/src/EnclaveRegistry.sol at the reviewed commit.
  EnclaveRegistry: '0x816055d98d18280b7b6e980f42d0402b41ab2f79e37d06762c75b2dfea503f38',
};
// keccak256 of each reference creation bytecode (no constructor arguments, no suffix), recorded from the
// reference build (solc 0.8.26 with the pinned binary sha256, evm_version cancun, optimizer 10000 runs).
export const CREATION_PINNED = {
  P384Verifier: '0xd902925bf78c19c9d9b8ec5cf29aa0519af205a2cc319a31c7c18e57708a9c31',
  CertManager: '0xa0759b2099a1b9b340e8e9cfd104752a6738d2aff3a0656d33df6d34ef635ea2',
  NitroValidator: '0xab42ddd0eae9353d23b905d53f6837b9aa53a887c402445716e41931a0283e0d',
  EnclaveRegistry: '0xd11af52a9640df7b06bd4c44c77bfa573ba36ae7521decf4897fa8e348d12902',
};
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = '0x' + '0'.repeat(40);

/** The creation data's three parts. `data` is what the transaction carries. */
export function buildCreation(step, art, args, suffix) {
  const base = art.bytecode.object.replace(/^0x/, '').toLowerCase();
  const enc = args
    .map((a) => (typeof a === 'boolean' ? word(a) : word(a)))
    .join('');
  const sfx = suffix.replace(/^0x/, '').toLowerCase();
  return { base, args: enc, suffix: sfx, data: '0x' + base + enc + sfx };
}

const lc = (s) => s.toLowerCase();

/** The CREATE address: keccak256(rlp([sender, nonce]))[12:]. */
export function createAddress(deps, sender, nonce) {
  const n = nonce === 0 ? '80' : nonce < 128 ? nonce.toString(16).padStart(2, '0') : (() => {
    let h = nonce.toString(16);
    if (h.length % 2) h = '0' + h;
    return (0x80 + h.length / 2).toString(16) + h;
  })();
  const payload = '94' + sender.slice(2).toLowerCase() + n;
  const rlp = (0xc0 + payload.length / 2).toString(16) + payload;
  return '0x' + deps.keccak(rlp).slice(-40);
}
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function needAddress(env, name, what) {
  const v = env[name];
  if (v === undefined || v === '') throw new Refuse(`${name} is not set (${what})`);
  if (!ADDRESS_RE.test(v)) throw new Refuse(`${name} is not an address`);
  if (lc(v) === ZERO) throw new Refuse(`${name} is the zero address`);
  return lc(v);
}

function parseArgs(argv) {
  const a = { positional: [], deployer: null, account: null, rpcUrl: DEFAULT_RPC, out: null, tx: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Refuse(`${k} needs a value`);
      return argv[++i];
    };
    if (k === '--deployer') a.deployer = val();
    else if (k === '--account') a.account = val();
    else if (k === '--rpc-url') a.rpcUrl = val();
    else if (k === '--out') a.out = val();
    else if (k === '--tx') a.tx = val();
    else if (k.startsWith('-')) throw new Refuse(`unknown option ${k}`);
    else a.positional.push(k);
  }
  return a;
}

const USAGE =
  'usage: node scripts/tagged-deploy.mjs <p384|certmanager|nitro|registry> --deployer 0x.. --account <keystore-name> [--rpc-url URL] [--out DIR]\n' +
  '       node scripts/tagged-deploy.mjs check <step> <address> --deployer 0x.. [--rpc-url URL] [--tx 0x<hash>]';

/** The real dependencies; tests pass fakes. */
export function realDeps(rpcUrl) {
  return {
    rpc: (method, params) => rawRpc(rpcUrl, method, params),
    gitStatus: () => {
      try {
        return execFileSync('git', ['--no-replace-objects', '-C', ROOT, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) });
      } catch (e) {
        throw new Refuse(`cannot read the git status at ${ROOT}: ${String(e.message).split('\n')[0]}`);
      }
    },
    loadReference: () => referenceBuild().arts,
    keccak: (hex) => keccak(Buffer.from(hex.replace(/^0x/, ''), 'hex')),
    tmp: () => join(tmpdir(), `attessa-tagged-deploy-${process.getuid?.() ?? 'u'}`),
  };
}

/** Everything that must hold before any data is written. Returns the validated inputs. */
async function preflight(step, a, env, deps, { needAccount }) {
  // 1. the tag. An error never shows its value, valid or not (it is public once mined, and the success
  // output prints the suffix, which contains it).
  const tag = env.LOOPS_ATTRIBUTION_TAG;
  if (tag === undefined || tag === '') throw new Refuse('LOOPS_ATTRIBUTION_TAG is not set');
  let suffix;
  try {
    suffix = attributionSuffix(tag);
  } catch {
    throw new Refuse('LOOPS_ATTRIBUTION_TAG is not a valid ERC-8021 code (1 to 32 characters of a-z, 0-9 or _); its value is not shown');
  }
  // 2. deployer, account, admin
  if (!a.deployer || !ADDRESS_RE.test(a.deployer)) throw new Refuse('--deployer must be the deploying account address');
  const deployer = lc(a.deployer);
  if (needAccount && (!a.account || !/^[A-Za-z0-9_.-]{1,64}$/.test(a.account))) {
    throw new Refuse('--account must be the Foundry keystore name (letters, digits, _ . -); keys come only from the keystore');
  }
  const admin = needAddress(env, 'ATTESSA_ADMIN', 'the cold admin');
  if (admin === deployer) throw new Refuse('ATTESSA_ADMIN must be the cold admin key, not the deployer');
  let url;
  try {
    url = new URL(a.rpcUrl);
  } catch {
    throw new Refuse('--rpc-url is not a URL');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Refuse('--rpc-url must be an http(s) URL without credentials');
  }
  // 3. the chain
  const chainId = parseInt(await deps.rpc('eth_chainId', []), 16);
  if (chainId !== CHAIN_ID) throw new Refuse(`the RPC reports chain ${chainId}, not Celo mainnet ${CHAIN_ID}`);
  // 4. the tree: the reference is built from HEAD, so HEAD must be what is checked out
  if (deps.gitStatus().trim() !== '') throw new Refuse('the git tree is not clean; deploy only from the committed, reviewed commit');
  return { suffix, deployer, admin };
}

async function codeOf(deps, addr) {
  return lc(await deps.rpc('eth_getCode', [addr, 'latest']));
}

async function callAddr(deps, arts, name, to, sig) {
  const sel = arts[name].methodIdentifiers[sig];
  if (!sel) throw new Refuse(`${name} artifact has no ${sig}`);
  let r;
  try {
    r = await deps.rpc('eth_call', [{ to, data: '0x' + sel }, 'latest']);
  } catch (e) {
    throw new Refuse(`${name}.${sig} at ${to} did not answer (${e.message})`);
  }
  if (typeof r !== 'string' || r.length !== 66) throw new Refuse(`${name}.${sig} at ${to} returned something that is not an address`);
  return '0x' + r.slice(26).toLowerCase();
}

/** runtime code with every immutable word zeroed, hashed: the whole-code pin of DeployBase.sol. */
function zeroedHash(deps, art, code) {
  let hex = code.replace(/^0x/, '');
  for (const refs of Object.values(art.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of refs) hex = hex.slice(0, start * 2) + '0'.repeat(length * 2) + hex.slice((start + length) * 2);
  }
  return deps.keccak(hex);
}

/**
 * The deployed contract at `addr` is the production `step` contract with `values` as its
 * immutables: code present, runtime code equal to the reference build, the whole-code pin
 * (immutables zeroed) for the three validator-stack contracts. Throws Refuse otherwise.
 */
async function requireRuntime(step, addr, values, arts, deps, label) {
  const name = CONTRACT[step];
  const code = await codeOf(deps, addr);
  if (code === '0x') throw new Refuse(`${label} ${addr} has no code`);
  const want = expectedRuntime(arts[name], name, values);
  const at = firstDiff(code, want);
  if (at !== -1) throw new Refuse(`${label} ${addr} is not the production ${name}: its runtime code first differs from the reference at byte ${at}`);
  if (PINNED[name] && zeroedHash(deps, arts[name], code) !== PINNED[name]) {
    throw new Refuse(`${label} ${addr} is not the pinned ${name} build (whole-code pin, immutables zeroed)`);
  }
}

/**
 * The reference build is the pinned build, for all four contracts: the runtime embedded in each creation
 * bytecode, immutables zeroed, hashes to its pin, and the whole creation bytecode hashes to its pin.
 * Throws Refuse otherwise, so a wrong compiler, evm_version, source or optimizer never reaches a command.
 */
export function verifyReference(arts, deps) {
  for (const name of Object.values(CONTRACT)) {
    const art = arts?.[name];
    if (!art?.bytecode?.object || !art?.deployedBytecode?.object) throw new Refuse(`the reference build has no ${name} artifact`);
    const creation = art.bytecode.object.replace(/^0x/, '').toLowerCase();
    const runtime = art.deployedBytecode.object.replace(/^0x/, '').toLowerCase();
    const at = creation.indexOf(runtime);
    if (runtime === '' || at === -1) throw new Refuse(`the reference ${name} creation bytecode does not embed its runtime code`);
    if (zeroedHash(deps, art, runtime) !== PINNED[name]) {
      throw new Refuse(`the reference ${name} is not the pinned build: its runtime code, immutables zeroed, differs from the whole-code pin`);
    }
    if (deps.keccak(creation) !== CREATION_PINNED[name]) {
      throw new Refuse(`the reference ${name} is not the pinned build: its creation bytecode differs from the creation pin`);
    }
  }
}

/** The constructor arguments of `step`, in SPEC §3.5 order, from the already-validated values. */
function constructorArgs(step, v, admin) {
  const pin = PINS.celo;
  if (step === 'p384') return [];
  if (step === 'certmanager') return [v.p384, admin, admin];
  if (step === 'nitro') return [v.certManager, v.p384];
  return [pin.identityRegistry, v.nitroValidator, pin.selfRegistry, false];
}

/** Reads back what the constructor set. */
async function requireWiring(step, addr, v, arts, deps, label) {
  const eq = async (name, sig, want) => {
    const got = await callAddr(deps, arts, name, addr, sig);
    if (got !== want) throw new Refuse(`${label} ${addr}: ${name}.${sig} is ${got}, expected ${want}`);
  };
  if (step === 'certmanager') {
    await eq('CertManager', 'p384Verifier()', v.p384);
    await eq('CertManager', 'owner()', v.admin);
    await eq('CertManager', 'revoker()', v.admin);
  } else if (step === 'nitro') {
    await eq('NitroValidator', 'certManager()', v.certManager);
    await eq('NitroValidator', 'p384Verifier()', v.p384);
  } else if (step === 'registry') {
    await eq('EnclaveRegistry', 'nitroValidator()', v.nitroValidator);
    await eq('EnclaveRegistry', 'identityRegistry()', v.identity);
    await eq('EnclaveRegistry', 'selfRegistry()', v.self);
    const sel = arts.EnclaveRegistry.methodIdentifiers['allowLocalOrigins()'];
    const r = await deps.rpc('eth_call', [{ to: addr, data: '0x' + sel }, 'latest']);
    if (r !== '0x' + word(false)) throw new Refuse(`${label} ${addr}: allowLocalOrigins() is not false`);
  }
}

/**
 * What `step` needs to exist already. Returns the constructor arguments for `step` (for the
 * registry, the same checks DeployBase._requireProductionStack makes, plus code at the pinned
 * identity and Self registries), after verifying every prior-step contract.
 */
async function priorStepsAndArgs(step, env, admin, arts, deps) {
  const pin = PINS.celo;
  if (step === 'p384') return { args: [], values: {} };
  if (step === 'certmanager') {
    const p384 = needAddress(env, 'ATTESSA_P384_VERIFIER', 'the P384Verifier from step 1');
    await requireRuntime('p384', p384, {}, arts, deps, 'ATTESSA_P384_VERIFIER');
    return { args: [p384, admin, admin], values: { p384 } };
  }
  if (step === 'nitro') {
    const p384 = needAddress(env, 'ATTESSA_P384_VERIFIER', 'the P384Verifier from step 1');
    const certManager = needAddress(env, 'ATTESSA_CERT_MANAGER', 'the CertManager from step 2');
    await requireRuntime('p384', p384, {}, arts, deps, 'ATTESSA_P384_VERIFIER');
    await requireRuntime('certmanager', certManager, { p384Verifier: p384 }, arts, deps, 'ATTESSA_CERT_MANAGER');
    await requireWiring('certmanager', certManager, { p384, admin }, arts, deps, 'ATTESSA_CERT_MANAGER');
    return { args: [certManager, p384], values: { certManager, p384 } };
  }
  // registry: the validator names its own CertManager and P384Verifier, as the Solidity check reads them.
  const validator = needAddress(env, 'ATTESSA_NITRO_VALIDATOR', 'the NitroValidator from step 3');
  if ((await codeOf(deps, validator)) === '0x') throw new Refuse(`ATTESSA_NITRO_VALIDATOR ${validator} has no code`);
  const certManager = await callAddr(deps, arts, 'NitroValidator', validator, 'certManager()');
  const p384 = await callAddr(deps, arts, 'NitroValidator', validator, 'p384Verifier()');
  await requireRuntime('p384', p384, {}, arts, deps, "the validator's P384Verifier");
  await requireRuntime('certmanager', certManager, { p384Verifier: p384 }, arts, deps, "the validator's CertManager");
  await requireRuntime('nitro', validator, { certManager, p384Verifier: p384 }, arts, deps, 'ATTESSA_NITRO_VALIDATOR');
  await requireWiring('certmanager', certManager, { p384, admin }, arts, deps, "the validator's CertManager");
  for (const [n, a] of [['ERC-8004 identity registry', pin.identityRegistry], ['Self registry', pin.selfRegistry]]) {
    if ((await codeOf(deps, a)) === '0x') throw new Refuse(`the pinned ${n} ${a} has no code on chain ${CHAIN_ID}`);
  }
  return { args: [pin.identityRegistry, validator, pin.selfRegistry, false], values: { validator } };
}

function requireStep(s) {
  if (!STEPS.includes(s)) throw new Refuse(`unknown step "${s}"; the steps, in order, are ${STEPS.join(', ')}`);
}

/** Resolves `dir` through symlinks as far as it exists, then appends the part that does not. */
function resolveReal(dir) {
  let cur = resolve(dir);
  const rest = [];
  while (!existsSync(cur)) {
    rest.unshift(basename(cur));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return join(realpathSync(cur), ...rest);
}

export function insideRepo(dir) {
  const rel = relative(realpathSync(ROOT), resolveReal(dir));
  // A first segment that merely starts with ".." (a directory named "..x") is inside, not outside.
  const outside = rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
  return !outside;
}

/**
 * The output directory is one this user owns and nobody else can write: not a symlink, not a file, owned
 * by the current user, not group/other writable. Created mode 0700 if absent. Throws Refuse otherwise.
 */
export function secureOutDir(dir) {
  const look = () => {
    try {
      return lstatSync(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Refuse(`cannot inspect the output directory ${dir} (${e.code})`);
    }
  };
  let st = look();
  if (st === null) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    st = look();
    if (st === null) throw new Refuse(`could not create the output directory ${dir}`);
  }
  if (st.isSymbolicLink()) throw new Refuse(`the output directory ${dir} is a symlink; use a real directory you own`);
  if (!st.isDirectory()) throw new Refuse(`the output path ${dir} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Refuse(`the output directory ${dir} is owned by uid ${st.uid}, not you (${uid})`);
  if (st.mode & 0o022) throw new Refuse(`the output directory ${dir} is writable by other users (mode ${(st.mode & 0o777).toString(8)}); chmod 700 it`);
}

/** Writes the data file for `step` and returns what to print. Signs and sends nothing. */
export async function prepare(step, a, env, deps, log = console.log) {
  requireStep(step);
  const { suffix, deployer, admin } = await preflight(step, a, env, deps, { needAccount: true });
  const dir = resolve(a.out ?? deps.tmp());
  if (insideRepo(dir)) throw new Refuse('--out is inside the repository, which would dirty the tree for the next step; use a directory outside it');
  const arts = deps.loadReference();
  const { args } = await priorStepsAndArgs(step, env, admin, arts, deps);
  verifyReference(arts, deps);
  const c = buildCreation(step, arts[CONTRACT[step]], args, suffix);
  // Self-check before anything is written: the data is bytecode ++ args ++ suffix and nothing else.
  if (!c.data.endsWith(c.suffix) || c.data.slice(2, -c.suffix.length) !== c.base + c.args) throw new Refuse('internal: creation data is not bytecode ++ args ++ suffix');

  const file = join(dir, `${step}.creation.hex`);

  // A fresh estimate of the exact tagged data (eth_estimateGas: read-only).
  let est;
  try {
    est = Number(BigInt(await deps.rpc('eth_estimateGas', [{ from: deployer, data: c.data }])));
  } catch (e) {
    // Not e.message: a node's error text can echo the creation input, and with it the tag.
    throw new Refuse(`gas estimate of the tagged ${step} creation failed. Check the --rpc-url, the deployer's funds and the env addresses, then run prepare again.`);
  }
  const limit = Math.ceil(est * 1.3);
  if (limit > GAS_CAP) throw new Refuse(`the estimate ${est} x 1.3 = ${limit} exceeds Celo's per-transaction cap ${GAS_CAP}; nothing written`);

  secureOutDir(dir);
  writeFileSync(file, c.data + '\n', { mode: 0o600 });
  log(`step          ${step} (${CONTRACT[step]})`);
  log(`chain         ${CHAIN_ID}`);
  log(`deployer      ${deployer}`);
  log(`data file     ${file}`);
  log(`data length   ${(c.data.length - 2) / 2} bytes = ${c.base.length / 2} bytecode + ${c.args.length / 2} args + ${c.suffix.length / 2} suffix`);
  log(`suffix        0x${c.suffix}`);
  const nonce = Number(BigInt(await deps.rpc('eth_getTransactionCount', [deployer, 'pending'])));
  const expected = createAddress(deps, deployer, nonce);
  log(`nonce         ${nonce}`);
  log(`expected addr ${expected} (CREATE of the deployer at that nonce)`);
  log(`gas estimate  ${est}`);
  log(`gas limit     ${limit} (estimate x 1.3, cap ${GAS_CAP})`);
  log('');
  log('Nothing was signed or sent. To deploy, run this yourself:');
  log('');
  // Options first: `--create` is a clap subcommand of `cast send`, and it rejects its parent's options after it.
  log(`cast send --account ${shq(a.account)} --from ${deployer} --rpc-url ${shq(a.rpcUrl)} --gas-limit ${limit} --create "$(cat ${shq(file)})"`);
  log('');
  log(`Then record the contract address and post-check it: node scripts/tagged-deploy.mjs check ${step} <address> --deployer ${deployer} --tx <hash>`);
  return { file, data: c.data, estimate: est, gasLimit: limit, expected, nonce };
}

/** The step's post-check. `a.tx`, if given, must be the creation of the file `prepare` wrote. */
export async function check(step, addr, a, env, deps, log = console.log) {
  requireStep(step);
  if (!ADDRESS_RE.test(addr ?? '')) throw new Refuse('check needs the deployed contract address');
  addr = lc(addr);
  const { suffix, deployer, admin } = await preflight(step, a, env, deps, { needAccount: false });
  const arts = deps.loadReference();
  verifyReference(arts, deps);
  const pin = PINS.celo;
  const name = CONTRACT[step];
  let values, v;
  if (step === 'p384') {
    values = {};
    v = {};
  } else if (step === 'certmanager') {
    const p384 = needAddress(env, 'ATTESSA_P384_VERIFIER', 'the P384Verifier');
    values = { p384Verifier: p384 };
    v = { p384, admin };
  } else if (step === 'nitro') {
    const p384 = needAddress(env, 'ATTESSA_P384_VERIFIER', 'the P384Verifier');
    const certManager = needAddress(env, 'ATTESSA_CERT_MANAGER', 'the CertManager');
    values = { certManager, p384Verifier: p384 };
    v = { certManager, p384 };
  } else {
    values = { identityRegistry: pin.identityRegistry, nitroValidator: needAddress(env, 'ATTESSA_NITRO_VALIDATOR', 'the NitroValidator'), selfRegistry: pin.selfRegistry, allowLocalOrigins: false };
    v = { nitroValidator: values.nitroValidator, identity: pin.identityRegistry, self: pin.selfRegistry };
  }
  await requireRuntime(step, addr, values, arts, deps, name);
  log(`OK    ${name} ${addr} has the production runtime code (immutables spliced)`);
  await requireWiring(step, addr, v, arts, deps, name);
  log(`OK    ${name} wiring reads back`);
  if (a.tx) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(a.tx)) throw new Refuse('--tx is not a transaction hash');
    const tx = await deps.rpc('eth_getTransactionByHash', [a.tx]);
    const rc = await deps.rpc('eth_getTransactionReceipt', [a.tx]);
    if (!tx || !rc) throw new Refuse('the transaction is not known to this RPC');
    if (tx.to !== null) throw new Refuse('the transaction is not a contract creation');
    if (lc(tx.from) !== deployer) throw new Refuse('the transaction was not sent by --deployer');
    if (lc(rc.contractAddress ?? '') !== addr) throw new Refuse('the transaction created a different address');
    if (rc.status !== '0x1') throw new Refuse('the transaction did not succeed');
    const input = lc(tx.input);
    if (!input.endsWith(suffix.slice(2).toLowerCase())) throw new Refuse('the creation input does not end with the attribution suffix');
    const made = createAddress(deps, tx.from, Number(BigInt(tx.nonce)));
    if (made !== addr) throw new Refuse(`the CREATE address from the sender and nonce is ${made}, not ${addr}`);
    log(`OK    address is the CREATE address of sender ${lc(tx.from)} and nonce ${BigInt(tx.nonce)}`);
    log(`OK    creation input ends with the attribution suffix (${(input.length - 2) / 2} bytes)`);
    // The whole input, rebuilt from the repo's reference build and the env: no data file needed.
    const want = buildCreation(step, arts[name], constructorArgs(step, v, admin), suffix).data;
    if (input !== want) {
      const at = firstDiff(input, want);
      throw new Refuse(`the creation input is not reference bytecode ++ constructor args ++ suffix: ${(input.length - 2) / 2} bytes vs ${(want.length - 2) / 2} expected, first difference at byte ${at}`);
    }
    log(`OK    creation input equals reference bytecode ++ constructor args ++ suffix (${(want.length - 2) / 2} bytes)`);
  }
  log(`OK: ${name} ${addr} passed`);
}

export async function main(argv, env, depsFor = realDeps, log = console.log) {
  const a = parseArgs(argv);
  const deps = depsFor(a.rpcUrl);
  if (a.positional[0] === 'check') {
    if (a.positional.length !== 3) throw new Refuse(USAGE);
    return check(a.positional[1], a.positional[2], a, env, deps, log);
  }
  if (a.positional.length !== 1) throw new Refuse(USAGE);
  return prepare(a.positional[0], a, env, deps, log);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2), process.env).then(
    () => process.exit(0),
    (e) => {
      console.error(e instanceof Refuse ? `tagged-deploy: ${e.message}` : e);
      process.exit(e instanceof Refuse ? 1 : 2);
    },
  );
}
