import { join } from 'node:path';
import { encodeUserData, normalizeOrigin, originHash } from '@attessa/core';
import { EnclaveClient, EnclaveUnreachable, NETWORK_PORTS, configureMessage } from '@attessa/seller-host';
import type { Address } from 'viem';
import { parseAttestation } from '../attestation.ts';
import { connect, type Deps, type Global } from '../context.ts';
import { COPY, CliError, ERR } from '../copy.ts';
import { parseAgent } from './owner.ts';

/**
 * Operator commands on the EC2 host (SPEC §4.5, §5, §8): `enclave build` (arm64 EIF, reproducible) and
 * `enclave start` (nitro-cli run-enclave on the network's CID, then `configure` through socat). Both shell
 * out only through `deps.runner`; neither runs anywhere but a Nitro-enabled arm64 host.
 */

/** SPEC §5: each enclave `--cpu-count 1 --memory 1024`, never `--debug-mode`. */
export const ENCLAVE_CPU = '1';
export const ENCLAVE_MEMORY_MIB = '1024';

async function git(deps: Deps, args: string[]): Promise<string> {
  const r = await deps.runner.run('git', args, { cwd: deps.cwd });
  if (r.code !== 0) throw new CliError('not_a_repo', `git ${args.join(' ')} failed: ${r.stderr.trim()}`, "Run it in your service's repo.");
  return r.stdout.trim();
}

/** `https://github.com/acme/risk.git` or `git@github.com:acme/risk.git` → `acme/risk`. */
export function repoLabel(remote: string): string {
  const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : remote.trim();
}

function requireHost(deps: Deps): void {
  if (deps.arch !== 'arm64') {
    throw new CliError('wrong_host', `Enclave images are built and run on the arm64 EC2 host (this machine is ${deps.arch}).`, 'Run this on the c6g host.');
  }
}

export async function enclaveBuild(_g: Global, deps: Deps, o: { name?: string }): Promise<number> {
  requireHost(deps);
  const kaniko = deps.env.ATTESSA_KANIKO_IMAGE;
  if (!kaniko || !/@sha256:[0-9a-f]{64}$/.test(kaniko)) {
    throw new CliError('kaniko_unpinned', 'ATTESSA_KANIKO_IMAGE must name the kaniko executor image pinned by digest (…@sha256:<64 hex>).', null);
  }
  // SPEC §4.5: refuse a dirty tree, so the PCRs belong to a commit.
  if ((await git(deps, ['status', '--porcelain'])) !== '') {
    throw new CliError('dirty_tree', 'Not built: the working tree has uncommitted changes, so the build would match no commit.', 'Commit or stash them, then run attessa enclave build again.');
  }
  const sha = await git(deps, ['rev-parse', 'HEAD']);
  const epoch = await git(deps, ['log', '-1', '--format=%ct']);
  const repo = repoLabel(await git(deps, ['remote', 'get-url', 'origin']).catch(() => deps.cwd));
  const name = o.name ?? repo.split('/').pop()!;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw ERR.usage('--name must be lowercase letters, digits and dashes.');
  const dockerfile = join(deps.cwd, 'enclave', 'Dockerfile');
  if (!deps.exists(dockerfile)) throw new CliError('no_dockerfile', `No enclave/Dockerfile in ${deps.cwd}.`, null);
  const tag = `attessa/${name}:${sha.slice(0, 12)}`;
  const env = { SOURCE_DATE_EPOCH: epoch };
  const steps: Array<[string, string[]]> = [
    [
      'docker',
      [
        'run', '--rm', '-e', `SOURCE_DATE_EPOCH=${epoch}`, '-v', `${deps.cwd}:/workspace`, kaniko,
        '--context', 'dir:///workspace', '--dockerfile', '/workspace/enclave/Dockerfile',
        '--reproducible', '--no-push', '--tar-path', `/workspace/build/${name}.tar`, '--destination', tag,
      ],
    ],
    ['docker', ['load', '-i', join('build', `${name}.tar`)]],
    ['nitro-cli', ['build-enclave', '--docker-uri', tag, '--output-file', join('build', `${name}.eif`)]],
  ];
  let measurements = '';
  for (const [cmd, args] of steps) {
    const r = await deps.runner.run(cmd, args, { cwd: deps.cwd, env });
    if (r.code !== 0) throw new CliError('build_failed', `${cmd} ${args[0]} failed (exit ${r.code}): ${r.stderr.trim().split('\n').at(-1) ?? ''}`, null);
    if (cmd === 'nitro-cli') measurements = r.stdout;
  }
  let parsed: { Measurements?: Record<string, string> };
  try {
    parsed = JSON.parse(measurements) as typeof parsed;
  } catch {
    throw ERR.invalidBuildFile('nitro-cli output');
  }
  if (!['PCR0', 'PCR1', 'PCR2'].every((k) => /^[0-9a-f]{96}$/i.test(parsed.Measurements?.[k] ?? ''))) throw ERR.invalidBuildFile('nitro-cli output');
  deps.writeFile(join(deps.cwd, 'build', 'measurements.json'), `${JSON.stringify(parsed, null, 2)}\n`);
  deps.io.out(COPY.built(`build/${name}.eif`, `${repo} @ ${sha.slice(0, 7)}`));
  return 0;
}

export interface StartOptions {
  agent?: string;
  origin?: string;
  port?: string;
  testBuild?: boolean;
  eif?: string;
  out?: string;
}

/** The single `.eif` in ./build, unless `--eif` names one. */
function findEif(deps: Deps, flag: string | undefined): string {
  if (flag) return flag;
  const dir = join(deps.cwd, 'build');
  const eifs = deps.exists(dir) ? deps.readdir(dir).filter((f) => f.endsWith('.eif')) : [];
  if (eifs.length !== 1) throw ERR.usage(`Found ${eifs.length} .eif files in build/; pass --eif <file>.`);
  return join('build', eifs[0]!);
}

export async function enclaveStart(g: Global, deps: Deps, o: StartOptions): Promise<number> {
  requireHost(deps);
  const agentId = parseAgent(o.agent);
  if (!o.origin) throw ERR.usage('--origin is required, like https://risk.example.');
  let origin: string;
  try {
    origin = normalizeOrigin(o.origin, { local: g.network === 'local' });
  } catch {
    throw ERR.invalidOrigin();
  }
  if (g.network === 'local' && !o.testBuild && !o.port) throw ERR.usage('--network local needs --port.');
  const net = o.testBuild ? 'test' : g.network === 'local' ? null : g.network;
  const layout = net ? NETWORK_PORTS[net] : null;
  const fixedPort = net ? (deps.socatPorts?.[net] ?? NETWORK_PORTS[net].socatPort) : null;
  const port = o.port ? Number(o.port) : fixedPort!;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw ERR.usage('--port must be a TCP port.');
  if (!layout) throw ERR.usage('--network local has no enclave CID; use --test-build or sepolia.');
  // SPEC §5 pins each CID behind one socat port: any other port configures another network's enclave.
  // not in FLOWS: worded like seller-host's "enclavePort must be 5007 on sepolia".
  if (port !== fixedPort) throw ERR.usage(`--port must be ${fixedPort} ${net === 'test' ? 'with --test-build' : `on ${net}`}.`);
  const eif = findEif(deps, o.eif);
  // The registry and chain id the enclave binds into its attestation come from the chain itself.
  const c = await connect(g, deps);

  const run = await deps.runner.run('nitro-cli', [
    'run-enclave', '--eif-path', eif, '--cpu-count', ENCLAVE_CPU, '--memory', ENCLAVE_MEMORY_MIB, '--enclave-cid', String(layout.cid),
  ]);
  if (run.code !== 0) throw new CliError('enclave_start_failed', `nitro-cli run-enclave failed (exit ${run.code}): ${run.stderr.trim().split('\n').at(-1) ?? ''}`, null);
  deps.io.out(COPY.starting(eif));

  const client = new EnclaveClient(deps.enclave(port));
  const cfg = configureMessage({ chainId: c.chainId, registry: c.registry, agentId, origin });
  let att: { attestation: string };
  for (let i = 0; ; i++) {
    try {
      att = await client.configureOrAttest(cfg, 5_000);
      break;
    } catch (e) {
      // The enclave takes a few seconds to boot; an enclave that exits instead (no NSM) never answers.
      if (!(e instanceof EnclaveUnreachable) || i >= 30) throw ERR.nsmUnavailable();
      await deps.sleep(2_000);
    }
  }
  const doc = Buffer.from(att.attestation, 'base64');
  // If seller-host configured it first with other values, say so now rather than at registration.
  const parsed = parseAttestation(doc);
  const expected = encodeUserData({ chainId: BigInt(c.chainId), registry: c.registry as Address, agentId, originHash: originHash(origin) });
  if (parsed.userData?.toLowerCase() !== expected.toLowerCase()) {
    throw ERR.bindingMismatch('a different agent, chain or origin than this command asked for', 'configure');
  }
  const out = o.out ?? 'att.bin';
  deps.writeFile(join(deps.cwd, out), doc);
  deps.io.out(COPY.started(out));
  return 0;
}
