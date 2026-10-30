#!/usr/bin/env node
// T10/T30 (SPEC §3.5): checks a deployed Attessa stack against docs/DEPLOYMENTS.md,
// packages/core/src/deployments.ts and the compiled production artifacts in contracts/out.
// Read-only: eth_chainId, eth_getCode and eth_call only.
//
//   node scripts/check-deploy.mjs <network> [--rpc-url URL] [--deployments FILE] [--core FILE]
//
// Needs `forge build` in contracts/ first (the artifacts are the reference bytecode), a clean
// contracts/src and nitro-validator, and `cast` on PATH (keccak256 of the sources).
// Exit 0: every check printed OK. Exit 1: a check failed. Exit 2: could not run (bad input,
// TODO addresses, missing artifacts, RPC error).

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PINNED_VALIDATOR_COMMIT = '0ea0d12';
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
    const m = /^\|\s*([A-Za-z0-9]+)\s*\|\s*`([^`]*)`\s*\|/.exec(lines[i]);
    if (!m) continue;
    if (m[1] in rows) throw new Refuse(`DEPLOYMENTS.md ${network}: ${m[1]} row appears twice`);
    rows[m[1]] = m[2].trim();
  }
  const out = {};
  for (const name of ['Admin', ...OURS]) {
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

function artifact(name) {
  const p = `${ROOT}/contracts/out/${name}.sol/${name}.json`;
  if (!existsSync(p)) throw new Refuse(`missing ${p}; run \`forge build\` in contracts/ first`);
  const a = JSON.parse(readFileSync(p, 'utf8'));
  if (Object.keys(a.deployedBytecode.linkReferences ?? {}).length) throw new Refuse(`${name} artifact has unlinked libraries`);
  return a;
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

  const arts = Object.fromEntries(OURS.map((n) => [n, artifact(n)]));
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

  // Provenance: the reference artifacts must come from the pinned, unmodified sources. The commit
  // alone is not enough: a dirty submodule or a stale contracts/out passes it (T10 adversary).
  const git = (dir, ...a) => {
    try {
      return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
    } catch (e) {
      return `(git failed: ${e.message.split('\n')[0]})`;
    }
  };
  const validatorDir = `${ROOT}/contracts/lib/nitro-validator`;
  const commit = git(validatorDir, 'rev-parse', 'HEAD');
  const validatorDirty = git(validatorDir, 'status', '--porcelain', '--ignore-submodules=none');
  check(
    `nitro-validator is at ${PINNED_VALIDATOR_COMMIT} with a clean tree`,
    commit.startsWith(PINNED_VALIDATOR_COMMIT) && validatorDirty === '',
    `submodule is at ${commit}${validatorDirty ? `, uncommitted changes:\n${validatorDirty}` : ''}`,
  );
  const srcDirty = git(ROOT, 'status', '--porcelain', '--', 'contracts/src');
  check('contracts/src has no uncommitted changes', srcDirty === '', srcDirty);
  // Every source in each artifact's metadata must be under src/ or the pinned submodule, and
  // match the file on disk byte for byte (keccak256, as solc records it). With the clean-tree
  // checks above, that ties contracts/out to the pinned code; the runtime code comparison below
  // then ties the chain to contracts/out, metadata hash included.
  for (const n of OURS) {
    const bad = [];
    for (const [path, { keccak256 }] of Object.entries(arts[n].metadata?.sources ?? {})) {
      if (!path.startsWith('src/') && !path.startsWith('lib/nitro-validator/src/')) {
        bad.push(`${path} is outside src/ and lib/nitro-validator/src/`);
        continue;
      }
      const file = `${ROOT}/contracts/${path}`;
      if (!existsSync(file)) {
        bad.push(`${path} is missing`);
        continue;
      }
      const onDisk = execFileSync('cast', ['keccak'], { input: readFileSync(file), encoding: 'utf8' }).trim();
      if (onDisk !== keccak256) bad.push(`${path} on disk ${onDisk}, artifact built from ${keccak256}`);
    }
    if (!arts[n].metadata?.sources) bad.push('artifact has no metadata.sources');
    check(`${n} artifact was built from the sources on disk`, bad.length === 0, `rebuild with \`forge build\`:\n  ${bad.join('\n  ')}`);
  }

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
