import { randomBytes } from 'node:crypto';
import { encodeUserData, originHash, releaseId } from '@attessa/core';
import { EnclaveClient, InputFetcher, HttpRpcSource, SellerHost, TcpEnclaveTransport } from '@attessa/seller-host';
import { toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { FakeEnclave } from '../../seller-host/test/fake-enclave.ts';
import type { Deps, RunResult } from '../src/context.ts';
import { hintPlan, parseAttestation } from '../src/attestation.ts';
import { run } from '../src/index.ts';
import { FakeChain, REGISTRY } from './fake-chain.ts';
import { FakeNitroChain } from './fake-nitro.ts';

export const AGENT = 412n;
export const ORIGIN = 'https://risk.example';

export interface World {
  chain: FakeChain;
  ownerKey: Hex;
  owner: Address;
  operatorKey: Hex;
  operator: Address;
  nitro: FakeNitroChain;
  pcrs: [Buffer, Buffer, Buffer];
  rid: Hex;
  files: Map<string, Buffer>;
  out: string[];
  err: string[];
  runs: Array<{ cmd: string; args: string[]; env?: Record<string, string> | undefined }>;
  runnerReply: (cmd: string, args: string[]) => RunResult;
  confirmAnswer: boolean;
  env: Record<string, string | undefined>;
  arch: string;
  /** Socat port per enclave on this fake host: 1 (nothing listens) until `sellerHost` puts a fake enclave behind one. */
  socatPorts: { mainnet: number; sepolia: number; test: number } | undefined;
  deps(): Deps;
  cli(...argv: string[]): Promise<number>;
}

export function world(): World {
  const chain = new FakeChain();
  const ownerKey = generatePrivateKey();
  const operatorKey = generatePrivateKey();
  const pcrs: [Buffer, Buffer, Buffer] = [randomBytes(48), randomBytes(48), randomBytes(48)];
  const w: World = {
    chain,
    ownerKey,
    owner: privateKeyToAccount(ownerKey).address.toLowerCase() as Address,
    operatorKey,
    operator: privateKeyToAccount(operatorKey).address.toLowerCase() as Address,
    nitro: new FakeNitroChain(),
    pcrs,
    rid: releaseId(toHex(pcrs[0]), toHex(pcrs[1]), toHex(pcrs[2])),
    files: new Map(),
    out: [],
    err: [],
    runs: [],
    runnerReply: () => ({ code: 0, stdout: '', stderr: '' }),
    confirmAnswer: true,
    env: { ATTESSA_REGISTRY: REGISTRY },
    arch: 'arm64',
    socatPorts: { mainnet: 1, sepolia: 1, test: 1 },
    deps() {
      return {
        io: {
          out: (l) => w.out.push(l),
          err: (l) => w.err.push(l),
          confirm: async () => w.confirmAnswer,
        },
        env: w.env,
        cwd: '/srv/risk',
        rpc: () => chain,
        runner: {
          run: async (cmd, args, opts) => {
            w.runs.push({ cmd, args, env: opts?.env });
            return w.runnerReply(cmd, args);
          },
        },
        fetch,
        enclave: (port) => new TcpEnclaveTransport(port),
        readFile: (p) => {
          const f = w.files.get(p);
          if (!f) throw new Error(`ENOENT ${p}`);
          return f;
        },
        writeFile: (p, d) => void w.files.set(p, Buffer.from(d)),
        exists: (p) => [...w.files.keys()].some((k) => k === p || k.startsWith(`${p}/`)),
        readdir: (p) => [...w.files.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1)),
        // Receipts appear once the fake chain has recovered the sender.
        sleep: () => chain.pending,
        arch: w.arch,
        socatPorts: w.socatPorts,
      };
    },
    cli: (...argv) => run(argv, w.deps()),
  };
  chain.owners.set(AGENT, w.owner);
  // This synthetic chain's root stands in for the pinned AWS root on the fake CertManager.
  chain.rootHash = hintPlan(parseAttestation(w.nitro.attest({ userData: null, publicKey: null, timestampMs: 0n }).document)).rootHash;
  return w;
}

/** Owner approved the release and added the endpoint with `operator` (FLOWS J3 tasks 1 and 2). */
export function onboarded(w: World): void {
  w.chain.releases.set(`${AGENT}:${w.rid}`, 1);
  w.chain.addEndpoint(AGENT, ORIGIN, '0x00000000000000000000000000000000000000fe', w.operator);
}

/** An attestation as NSM would bind it: user_data for (chain, registry, agent, origin), the enclave key, at `ageSec` old. */
export function attestation(w: World, o: { ageSec?: number; publicKey?: Hex; agentId?: bigint; pcrs?: [Buffer, Buffer, Buffer]; origin?: string } = {}): { doc: Buffer; publicKey: Hex } {
  const publicKey = o.publicKey ?? privateKeyToAccount(generatePrivateKey()).publicKey;
  const userData = encodeUserData({ chainId: BigInt(w.chain.chainId), registry: REGISTRY, agentId: o.agentId ?? AGENT, originHash: originHash(o.origin ?? ORIGIN) });
  const doc = w.nitro.attest({
    userData: Buffer.from(userData.slice(2), 'hex'),
    publicKey: Buffer.from(publicKey.slice(2), 'hex'),
    timestampMs: (w.chain.timestamp - BigInt(o.ageSec ?? 60)) * 1000n,
    pcrs: o.pcrs ?? w.pcrs,
  }).document;
  return { doc, publicKey };
}

/** A seller-host (the real package) in front of a fake enclave whose attestations come from `w.nitro`. */
export async function sellerHost(w: World): Promise<{ url: string; enclave: FakeEnclave; enclavePort: number; stop(): Promise<void> }> {
  const enclave = new FakeEnclave({
    makeAttestation: (userData, publicKey) =>
      w.nitro.attest({
        userData: Buffer.from(userData.slice(2), 'hex'),
        publicKey: Buffer.from(publicKey.slice(2), 'hex'),
        timestampMs: w.chain.timestamp * 1000n,
        pcrs: w.pcrs,
      }).document,
    clock: () => Number(w.chain.timestamp),
  });
  const enclavePort = await enclave.start();
  // This fake socat stands for whichever network the test starts.
  w.socatPorts = { mainnet: enclavePort, sepolia: enclavePort, test: enclavePort };
  const host = new SellerHost({
    config: { chainId: w.chain.chainId, registry: REGISTRY, agentId: AGENT, origin: ORIGIN },
    enclave: new EnclaveClient(new TcpEnclaveTransport(enclavePort)),
    inputs: new InputFetcher({ forno: new HttpRpcSource('forno', 'http://127.0.0.1:1') }),
  });
  const port = await host.listen(0);
  return {
    url: `http://127.0.0.1:${port}`,
    enclave,
    enclavePort,
    async stop() {
      await host.close();
      await enclave.stop();
    },
  };
}
