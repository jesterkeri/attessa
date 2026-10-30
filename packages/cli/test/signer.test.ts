import { originHash, signerFromPublicKey } from '@attessa/core';
import { decodeFunctionData, keccak256, parseTransaction, toFunctionSelector, type Hex, type TransactionSerialized } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CERT_MANAGER_ABI, REGISTRY_ABI } from '../src/abi.ts';
import { hintPlan, parseAttestation } from '../src/attestation.ts';
import { CERT_MANAGER, REGISTRY } from './fake-chain.ts';
import { AGENT, ORIGIN, attestation, onboarded, sellerHost, world, type World } from './harness.ts';

let w: World;
let stops: Array<() => Promise<void>> = [];
beforeEach(() => {
  w = world();
  onboarded(w);
});
afterEach(async () => {
  for (const s of stops) await s();
  stops = [];
});

const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-2)}`;
const SEL = {
  ca: toFunctionSelector('verifyCACertWithHints(bytes,bytes32,bytes)'),
  leaf: toFunctionSelector('verifyClientCertWithHints(bytes,bytes32,bytes)'),
  register: toFunctionSelector('registerSigner(uint256,bytes32,bytes,bytes)'),
  renew: toFunctionSelector('renewSigner(address,bytes,bytes)'),
};

function cacheCerts(w: World, doc: Buffer, n: number, notAfter = w.chain.timestamp + 3600n): void {
  for (const c of hintPlan(parseAttestation(doc)).certs.slice(0, n)) w.chain.certs.set(c.certHash, { notAfter, parent: c.parentCertHash });
}

function sentSelectors(w: World): string[] {
  return w.chain.sent.map((raw) => parseTransaction(raw as TransactionSerialized).data!.slice(0, 10));
}

describe('seller: attessa signer register (FLOWS §6 J3, SPEC §3.4)', () => {
  it('plans every missing certificate then registerSigner, simulating only what can run now, and sends nothing without a key', async () => {
    const { doc } = attestation(w);
    w.files.set('att.bin', doc);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin')).toBe(0);
    // 10.4M gas × 25 gwei = 0.26 CELO per tx; 5 txs ≈ 1.3 → "about 1 CELO"
    expect(w.out[0]).toBe(
      "This publishes the machine's key on Celo so buyers can check it. Up to 5 transactions, about 1 CELO at today's price (0 of 4 certificates already cached, so 5 transactions, about 1 CELO).  [register/cancel]",
    );
    const plan = w.out.filter((l) => l.startsWith('  (tx '));
    expect(plan).toHaveLength(5);
    expect(plan[0]).toContain(`cache CA certificate 1; from ${w.operator} to ${CERT_MANAGER}; eth_call ok`);
    expect(plan[1]).toContain('simulated after the previous transaction lands');
    expect(plan[3]).toContain('cache leaf certificate');
    expect(plan[4]).toContain(`registerSigner; from ${w.operator} to ${REGISTRY}; simulated after the previous transaction lands`);
    const calldata = w.out.filter((l) => l.startsWith('  (calldata ')).map((l) => l.slice(12, -1) as Hex);
    const reg = decodeFunctionData({ abi: REGISTRY_ABI, data: calldata[4]! });
    expect(reg.functionName).toBe('registerSigner');
    expect(reg.args[0]).toBe(AGENT);
    expect(reg.args[1]).toBe(originHash(ORIGIN));
    expect(reg.args[2]).toBe(`0x${doc.toString('hex')}`);
    const ca1 = decodeFunctionData({ abi: CERT_MANAGER_ABI, data: calldata[0]! });
    expect(ca1.args[1]).toBe(hintPlan(parseAttestation(doc)).rootHash);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('caches only missing certificates: 3 of 4 cached means one leaf tx and registerSigner, with the FLOWS lines', async () => {
    const enclaveHost = await sellerHost(w);
    stops.push(enclaveHost.stop);
    // The enclave is configured (seller-host boot), so --fresh gets an attestation for its running key.
    await new (await import('@attessa/seller-host')).EnclaveClient(
      new (await import('@attessa/seller-host')).TcpEnclaveTransport(enclaveHost.enclavePort),
    ).configureOrAttest({ chainId: String(w.chain.chainId), registry: REGISTRY, agentId: '412', origin: ORIGIN, rpcAllowedChains: [String(w.chain.chainId)] }, 2000);
    const probe = await w.cli('signer', 'register', '--agent', '412', '--fresh', '--seller-host', enclaveHost.url, '--dry-run');
    expect(probe).toBe(0);
    // Cache the first three certificates of the chain the enclave's documents use.
    const doc = Buffer.from(
      ((await (await fetch(`${enclaveHost.url}/internal/attest`, { method: 'POST', body: '{}' })).json()) as { attestation: string }).attestation,
      'base64',
    );
    cacheCerts(w, doc, 3);
    w.out.length = 0;
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    expect(await w.cli('signer', 'register', '--agent', '412', '--fresh', '--seller-host', enclaveHost.url, '--yes')).toBe(0);
    const signer = enclaveHost.enclave.signer;
    expect(sentSelectors(w)).toEqual([SEL.leaf, SEL.register]);
    expect(w.out[0]).toContain('(3 of 4 certificates already cached, so 2 transactions,');
    expect(w.out[1]).toMatch(/^\[1\/2\] Certificate cached {2}\(tx 0x[0-9a-f]{4}…[0-9a-f]{2}\)$/);
    expect(w.out[2]).toMatch(new RegExp(`^\\[2/2\\] Signer ${short(signer)} is live for risk\\.example, running agent 412's approved build {2}\\(tx 0x[0-9a-f]{4}…[0-9a-f]{2}\\)$`));
    expect(w.out[3]).toMatch(
      /^Valid until [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2} UTC, or until the machine restarts\. To renew without a restart: attessa signer renew\. After a restart \(new key\): attessa enclave start, then attessa signer register \(about 4–6 CELO, up to 8 if no certificates are cached\)\.$/,
    );
    expect(w.out[4]).toBe('Liveness check passed. Buyers can check this seller now.');
    expect(w.chain.signers.get(signer)).toMatchObject({ agentId: AGENT, releaseId: w.rid, operator: w.operator, status: 1 });
  });

  it('with every certificate cached: one registerSigner tx, simulated up front', async () => {
    const { doc, publicKey } = attestation(w);
    cacheCerts(w, doc, 4);
    w.files.set('att.bin', doc);
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--origin', ORIGIN, '--yes')).toBe(0);
    expect(sentSelectors(w)).toEqual([SEL.register]);
    expect(w.out[0]).toContain('(4 of 4 certificates already cached, so 1 transactions,');
    expect(w.chain.signers.get(signerFromPublicKey(publicKey))?.status).toBe(1);
  });

  it('stale attestation: FLOWS repair line with its age in minutes, nothing sent', async () => {
    const { doc } = attestation(w, { ageSec: 41 * 60 });
    w.files.set('att.bin', doc);
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--yes')).toBe(1);
    expect(w.err).toEqual([
      "Not registered: the machine's report is 41 minutes old and Celo accepts 30. Run `attessa signer register --fresh` to get a new report from the same machine (no restart).",
    ]);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('debug-mode PCRs: FLOWS repair line', async () => {
    const zero: [Buffer, Buffer, Buffer] = [Buffer.alloc(48), Buffer.alloc(48), Buffer.alloc(48)];
    w.files.set('att.bin', attestation(w, { pcrs: zero }).doc);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin')).toBe(1);
    expect(w.err).toEqual(["Not registered: the machine was started in debug mode, which AWS doesn't sign for. Start it without --debug-mode."]);
  });

  it('a build the owner has not approved: FLOWS repair line naming the release', async () => {
    w.chain.releases.clear();
    w.files.set('att.bin', attestation(w).doc);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin')).toBe(1);
    expect(w.err).toEqual([
      `Not registered: this machine runs a build agent 412 hasn't approved (release ${short(w.rid)}). Approve it with \`attessa release approve\`, or start the approved build.`,
    ]);
  });

  it('an attestation bound to another agent: binding_mismatch', async () => {
    w.files.set('att.bin', attestation(w, { agentId: 999n }).doc);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--origin', ORIGIN, '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({
      ok: false,
      error: 'binding_mismatch{4}',
      message: 'Not registered: the attestation was made for agent 999.',
      next: 'Re-attest with the right agent and origin in the config.',
    });
  });

  it('a key that is not the endpoint operator: not_operator', async () => {
    w.files.set('att.bin', attestation(w).doc);
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--origin', ORIGIN)).toBe(1);
    expect(w.err).toEqual([`Not registered: ${w.owner} isn't the operator for https://risk.example.`, 'Run from the operator wallet set in `attessa endpoint add`.']);
  });

  it('no active endpoint for the origin: endpoint_inactive', async () => {
    w.chain.endpoints.clear();
    w.files.set('att.bin', attestation(w).doc);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--origin', ORIGIN)).toBe(1);
    expect(w.err).toEqual(["Not registered: https://risk.example isn't an active endpoint for agent 412.", 'Add it with `attessa endpoint add`.']);
  });

  it('an expired cached certificate in the chain: cert_expired', async () => {
    const { doc } = attestation(w);
    cacheCerts(w, doc, 2, w.chain.timestamp - 1n);
    w.files.set('att.bin', doc);
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--origin', ORIGIN)).toBe(1);
    expect(w.err).toEqual(['The certificate chain in this attestation has expired.', 'Run `attessa signer register --fresh` (a fresh report carries current certificates).']);
  });

  it('a key that is already registered is refused before any certificate is paid for', async () => {
    const { doc, publicKey } = attestation(w);
    w.chain.signers.set(signerFromPublicKey(publicKey), {
      agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator,
      registeredAt: 0n, expiresAt: w.chain.timestamp + 100n, status: 1, attestationHash: keccak256(doc),
    });
    w.files.set('att.bin', doc);
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--yes')).toBe(1);
    expect(w.err[0]).toBe(`Not registered: signer ${short(signerFromPublicKey(publicKey))} is already registered.`);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('reads the origin for its lines from the EndpointAdded log when --origin is absent', async () => {
    w.chain.endpoints.clear();
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expect(await w.cli('endpoint', 'add', '--agent', '412', '--origin', ORIGIN, '--pay-to', '0x00000000000000000000000000000000000000fe', '--operator', w.operator, '--yes')).toBe(0);
    const { doc } = attestation(w);
    cacheCerts(w, doc, 4);
    w.files.set('att.bin', doc);
    w.out.length = 0;
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    expect(await w.cli('signer', 'register', '--agent', '412', '--attestation', 'att.bin', '--yes')).toBe(0);
    expect(w.out.find((l) => l.startsWith('[1/1] Signer'))).toContain('is live for risk.example,');
  });

  it('requires exactly one of --attestation or --fresh', async () => {
    expect(await w.cli('signer', 'register', '--agent', '412')).toBe(1);
    expect(w.err[0]).toBe('Pass exactly one of --attestation <file> or --fresh.');
  });
});

describe('seller: attessa signer renew (SPEC §3.4 renewSigner)', () => {
  async function registered() {
    const h = await sellerHost(w);
    stops.push(h.stop);
    const { EnclaveClient, TcpEnclaveTransport } = await import('@attessa/seller-host');
    await new EnclaveClient(new TcpEnclaveTransport(h.enclavePort)).configureOrAttest(
      { chainId: String(w.chain.chainId), registry: REGISTRY, agentId: '412', origin: ORIGIN, rpcAllowedChains: [String(w.chain.chainId)] },
      2000,
    );
    w.chain.signers.set(h.enclave.signer, {
      agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator,
      registeredAt: w.chain.timestamp - 518_400n, expiresAt: w.chain.timestamp + 86_400n, status: 1, attestationHash: `0x${'00'.repeat(32)}`,
    });
    return h;
  }

  it('fetches a fresh attestation from seller-host, caches only missing certs, and renews the running key', async () => {
    const h = await registered();
    const doc = Buffer.from(((await (await fetch(`${h.url}/internal/attest`, { method: 'POST', body: '{}' })).json()) as { attestation: string }).attestation, 'base64');
    cacheCerts(w, doc, 2);
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    const before = w.chain.signers.get(h.enclave.signer)!.expiresAt;
    expect(await w.cli('signer', 'renew', '--seller-host', h.url, '--yes')).toBe(0);
    expect(sentSelectors(w)).toEqual([SEL.ca, SEL.leaf, SEL.renew]);
    expect(w.out[0]).toContain(`This renews signer ${short(h.enclave.signer)} for 7 days`);
    expect(w.out[0]).toContain('(2 of 4 certificates already cached, so 3 transactions,');
    expect(w.out.at(-1)).toMatch(new RegExp(`^\\[3/3\\] Signer ${short(h.enclave.signer)} renewed, valid until .* UTC {2}\\(tx 0x`));
    expect(w.chain.signers.get(h.enclave.signer)!.expiresAt).toBeGreaterThan(before);
  });

  it('an expired signer cannot be renewed: FLOWS renew refusal with the restart path', async () => {
    const h = await registered();
    w.chain.signers.get(h.enclave.signer)!.expiresAt = w.chain.timestamp;
    expect(await w.cli('signer', 'renew', '--seller-host', h.url)).toBe(1);
    expect(w.err).toEqual(['Not renewed: the signer already expired.', 'Restart with `attessa enclave start`, then `attessa signer register`.']);
  });

  it('a report from a different build than the signer was registered with: release_mismatch', async () => {
    const h = await registered();
    w.chain.signers.get(h.enclave.signer)!.releaseId = `0x${'ab'.repeat(32)}`;
    expect(await w.cli('signer', 'renew', '--seller-host', h.url)).toBe(1);
    expect(w.err).toEqual(['Not renewed: this report is from a different build.', 'Run `attessa signer renew` on the machine that holds this key.']);
  });

  it('seller-host unreachable: says so, sends nothing', async () => {
    expect(await w.cli('signer', 'renew', '--seller-host', 'http://127.0.0.1:1')).toBe(1);
    expect(w.err[0]).toBe("Can't reach the seller-host at http://127.0.0.1:1.");
    expect(w.chain.sent).toHaveLength(0);
  });
});
