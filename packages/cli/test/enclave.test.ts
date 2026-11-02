import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAttestation } from '../src/attestation.ts';
import { REGISTRY } from './fake-chain.ts';
import { ORIGIN, sellerHost, world, type World } from './harness.ts';

let w: World;
let stops: Array<() => Promise<void>> = [];
beforeEach(() => {
  w = world();
});
afterEach(async () => {
  for (const s of stops) await s();
  stops = [];
});

const MEASUREMENTS = JSON.stringify({ Measurements: { HashAlgorithm: 'Sha384 { ... }', PCR0: 'a'.repeat(96), PCR1: 'b'.repeat(96), PCR2: 'c'.repeat(96) } });
const KANIKO = `gcr.io/kaniko-project/executor@sha256:${'1'.repeat(64)}`;

describe('seller: attessa enclave build (SPEC §4.5)', () => {
  beforeEach(() => {
    w.env.ATTESSA_KANIKO_IMAGE = KANIKO;
    w.files.set('/srv/risk/enclave/Dockerfile', Buffer.from('FROM scratch'));
    w.runnerReply = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n', stderr: '' };
      if (cmd === 'git' && args[0] === 'log') return { code: 0, stdout: '1793000000\n', stderr: '' };
      if (cmd === 'git' && args[0] === 'remote') return { code: 0, stdout: 'git@github.com:acme/risk.git\n', stderr: '' };
      if (cmd === 'nitro-cli') return { code: 0, stdout: MEASUREMENTS, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
  });

  it('builds with kaniko --reproducible at the commit time, then nitro-cli, and writes build/measurements.json', async () => {
    expect(await w.cli('enclave', 'build')).toBe(0);
    expect(w.out).toEqual(['Built build/risk.eif from acme/risk @ a1b2c3d. Measurements written to build/measurements.json.  Next: attessa release approve.']);
    const docker = w.runs.find((r) => r.cmd === 'docker' && r.args[0] === 'run')!;
    expect(docker.args).toContain(KANIKO);
    expect(docker.args).toContain('--reproducible');
    expect(docker.args).toContain('SOURCE_DATE_EPOCH=1793000000');
    expect(docker.env).toEqual({ SOURCE_DATE_EPOCH: '1793000000' });
    const nitro = w.runs.find((r) => r.cmd === 'nitro-cli')!;
    expect(nitro.args).toEqual(['build-enclave', '--docker-uri', 'attessa/risk:a1b2c3d4e5f6', '--output-file', 'build/risk.eif']);
    expect(JSON.parse(w.files.get('/srv/risk/build/measurements.json')!.toString())).toEqual(JSON.parse(MEASUREMENTS));
  });

  it('refuses a dirty tree before building anything', async () => {
    const reply = w.runnerReply;
    w.runnerReply = (cmd, args) => (cmd === 'git' && args[0] === 'status' ? { code: 0, stdout: ' M src/main.rs\n', stderr: '' } : reply(cmd, args));
    expect(await w.cli('enclave', 'build')).toBe(1);
    expect(w.err[0]).toBe('Not built: the working tree has uncommitted changes, so the build would match no commit.');
    expect(w.runs.some((r) => r.cmd === 'docker' || r.cmd === 'nitro-cli')).toBe(false);
  });

  it('refuses a kaniko image not pinned by digest, and any host that is not arm64', async () => {
    w.env.ATTESSA_KANIKO_IMAGE = 'gcr.io/kaniko-project/executor:latest';
    expect(await w.cli('enclave', 'build')).toBe(1);
    expect(w.err[0]).toMatch(/pinned by digest/);
    w.err.length = 0;
    w.arch = 'x64';
    expect(await w.cli('enclave', 'build')).toBe(1);
    expect(w.err[0]).toBe('Enclave images are built and run on the arm64 EC2 host (this machine is x64).');
    expect(w.runs).toHaveLength(0);
  });
});

describe('seller: attessa enclave start (SPEC §5, FLOWS §6 J3)', () => {
  beforeEach(() => {
    w.files.set('/srv/risk/build/risk.eif', Buffer.from('eif'));
  });

  it('runs the EIF on the network CID with 1 vCPU / 1024 MiB and no debug mode, configures it, and writes att.bin', async () => {
    const h = await sellerHost(w);
    stops.push(h.stop);
    expect(await w.cli('enclave', 'start', '--agent', '412', '--origin', ORIGIN, '--port', String(h.enclavePort))).toBe(0);
    expect(w.runs).toEqual([
      { cmd: 'nitro-cli', args: ['run-enclave', '--eif-path', 'build/risk.eif', '--cpu-count', '1', '--memory', '1024', '--enclave-cid', '17'], env: undefined },
    ]);
    expect(w.runs[0]!.args).not.toContain('--debug-mode');
    expect(w.out).toEqual([
      'Starting the sealed machine from build/risk.eif… running (Nitro enclave, 1 vCPU, 1 GiB)',
      "It made a fresh signing key and AWS signed a report of what's running  (attestation written to att.bin; register within 30 minutes, or get a fresh one any time with --fresh)",
    ]);
    expect(h.enclave.received[0]).toEqual({
      type: 'configure',
      chainId: '11142220',
      registry: REGISTRY,
      agentId: '412',
      origin: ORIGIN,
      rpcAllowedChains: ['11142220'],
    });
    expect(parseAttestation(w.files.get('/srv/risk/att.bin')!).publicKey).toBe(h.enclave.publicKey);
  });

  it('uses CID 16 on mainnet and CID 18 for --test-build', async () => {
    const h = await sellerHost(w);
    stops.push(h.stop);
    w.chain.chainId = 42220;
    // The mainnet enclave binds chain 42220; this fake seller-host enclave stays unconfigured until this call.
    await w.cli('enclave', 'start', '--network', 'mainnet', '--agent', '412', '--origin', ORIGIN, '--port', String(h.enclavePort));
    expect(w.runs[0]!.args.at(-1)).toBe('16');
    w.runs.length = 0;
    await w.cli('enclave', 'start', '--network', 'mainnet', '--test-build', '--agent', '412', '--origin', ORIGIN, '--port', String(h.enclavePort));
    expect(w.runs[0]!.args.at(-1)).toBe('18');
  });

  it('an enclave that never answers (no /dev/nsm, exit 3) gets the FLOWS nsm_unavailable lines', async () => {
    expect(await w.cli('enclave', 'start', '--agent', '412', '--origin', ORIGIN, '--port', '1')).toBe(1);
    expect(w.err).toEqual([
      "The sealed machine couldn't get a signed report from AWS (no /dev/nsm). Is this a Nitro-enabled instance?",
      'Use an instance type with enclaves enabled, like c6g.xlarge with --enclave-options Enabled=true.',
    ]);
  });

  it('an enclave already configured for another agent is caught before registration (binding)', async () => {
    const h = await sellerHost(w);
    stops.push(h.stop);
    expect(await w.cli('enclave', 'start', '--agent', '412', '--origin', ORIGIN, '--port', String(h.enclavePort))).toBe(0);
    expect(await w.cli('enclave', 'start', '--agent', '7', '--origin', ORIGIN, '--port', String(h.enclavePort))).toBe(1);
    expect(w.err[0]).toBe('Not registered: the attestation was made for a different agent, chain or origin than this command asked for.');
  });

  it('refuses to run anywhere but the arm64 host', async () => {
    w.arch = 'x64';
    expect(await w.cli('enclave', 'start', '--agent', '412', '--origin', ORIGIN)).toBe(1);
    expect(w.runs).toHaveLength(0);
  });
});
