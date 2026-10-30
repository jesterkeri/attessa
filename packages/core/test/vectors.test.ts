import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hexToBytes, type Address, type Hex } from 'viem';
import { buildVectors, serialize } from '../scripts/vectors.ts';
import {
  OriginError,
  decodeAttestedProof,
  derivedRequestId,
  eip712Domain,
  encodeUserData,
  inputsHash,
  isChallengeHeader,
  isRequestIdHeader,
  isRetryAfterHeader,
  jcs,
  livenessDigest,
  livenessFromJson,
  normalizeOrigin,
  originHash,
  parsePayerSig,
  payerSigDigest,
  payerSigMessage,
  proofDigest,
  proofFromJson,
  recoverDigestSigner,
  releaseId,
  requestHash,
  responseHash,
  signerFromPublicKey,
} from '../src/index.ts';

const dir = fileURLToPath(new URL('../../../vectors/', import.meta.url));
const FILES = ['origins.json', 'hashes.json', 'binding.json', 'eip712.json', 'headers.json'];
type Any = any;
const read = (f: string): Any => JSON.parse(readFileSync(dir + f, 'utf8'));

/** Every object in the file that has a `name` is one case. */
function countCases(v: unknown): number {
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + countCases(x), 0);
  if (v && typeof v === 'object') return 'name' in v ? 1 : Object.values(v).reduce((n: number, x) => n + countCases(x), 0);
  return 0;
}

describe('committed vectors', () => {
  it('match a fresh generation byte for byte', async () => {
    const fresh = await buildVectors();
    expect(Object.keys(fresh).sort()).toEqual([...FILES].sort());
    for (const f of FILES) expect(readFileSync(dir + f, 'utf8'), f).toBe(serialize(fresh[f]));
  });

  it('have at least 10 cases per file', () => {
    for (const f of FILES) expect(countCases(read(f)), f).toBeGreaterThanOrEqual(10);
  });

  // The checks below recompute each case from its JSON alone, as the Solidity and Rust runners will.

  it('origins.json', () => {
    const v = read('origins.json');
    for (const c of v.valid) {
      expect(normalizeOrigin(c.input, { local: c.local }), c.name).toBe(c.normalized);
      expect(originHash(c.normalized), c.name).toBe(c.originHash);
    }
    for (const c of v.invalid) {
      let reason = 'accepted';
      try {
        normalizeOrigin(c.input, { local: c.local });
      } catch (e) {
        reason = e instanceof OriginError ? e.reason : 'not an OriginError';
      }
      expect(reason, c.name).toBe(c.reason);
    }
  });

  it('hashes.json', () => {
    const v = read('hashes.json');
    for (const c of v.requestHash) expect(requestHash(c.method, c.pathAndQuery, hexToBytes(c.body)), c.name).toBe(c.expected);
    for (const c of v.responseHash) expect(responseHash(hexToBytes(c.body)), c.name).toBe(c.expected);
    for (const c of v.inputsHash) {
      expect(jcs(c.inputs), c.name).toBe(c.jcs);
      expect(inputsHash(c.inputs), c.name).toBe(c.expected);
    }
    for (const c of v.releaseId) expect(releaseId(c.pcr0, c.pcr1, c.pcr2), c.name).toBe(c.expected);
    for (const c of v.requestId) expect(derivedRequestId(c.asset, c.payer, c.nonce), c.name).toBe(c.expected);
  });

  it('binding.json', () => {
    const v = read('binding.json');
    for (const c of v.userData) {
      const ud = encodeUserData({ chainId: BigInt(c.chainId), registry: c.registry, agentId: BigInt(c.agentId), originHash: c.originHash });
      expect(ud, c.name).toBe(c.expected);
      expect(hexToBytes(ud)).toHaveLength(160);
    }
    for (const c of v.signer) expect(signerFromPublicKey(c.publicKey), c.name).toBe(c.expected);
  });

  it('eip712.json', async () => {
    const v = read('eip712.json');
    const fields = (c: Any, names: string[]) => Object.fromEntries(names.map((n) => [n, c[n]]));
    for (const c of v.proof) {
      const p = proofFromJson(fields(c, ['agentId', 'releaseId', 'requestId', 'requestHash', 'responseHash', 'inputsHash', 'paymentId', 'issuedAt', 'expiresAt']));
      expect(proofDigest(eip712Domain(BigInt(c.chainId), c.verifyingContract), p), c.name).toBe(c.digest);
    }
    for (const c of v.liveness) {
      const l = livenessFromJson(fields(c, ['agentId', 'releaseId', 'originHash', 'challenge', 'issuedAt']));
      expect(livenessDigest(eip712Domain(BigInt(c.chainId), c.verifyingContract), l), c.name).toBe(c.digest);
    }
    for (const c of v.signatures) {
      expect((await recoverDigestSigner(c.digest, c.signature)) ?? '', c.name).toBe(c.signer);
      expect(c.valid, c.name).toBe(c.signer !== '');
    }
  });

  it('headers.json', async () => {
    const v = read('headers.json');
    for (const c of v.bytes32.valid) expect(isRequestIdHeader(c.value) && isChallengeHeader(c.value), c.name).toBe(true);
    for (const c of v.bytes32.invalid) expect(isRequestIdHeader(c.value) || isChallengeHeader(c.value), c.name).toBe(false);
    for (const c of v.retryAfter.valid) expect(isRetryAfterHeader(c.value), c.name).toBe(true);
    for (const c of v.retryAfter.invalid) expect(isRetryAfterHeader(c.value), c.name).toBe(false);
    for (const c of v.payerSig.valid) {
      const parsed = parsePayerSig(c.header);
      expect(parsed, c.name).toEqual({ unixSeconds: Number(c.unixSeconds), signature: c.signature });
      expect(payerSigMessage(c.requestId, Number(c.unixSeconds))).toBe(c.message);
      expect(payerSigDigest(c.requestId as Hex, Number(c.unixSeconds))).toBe(c.digest);
      expect(await recoverDigestSigner(c.digest, c.signature)).toBe(c.signer);
    }
    for (const c of v.payerSig.invalid) expect(parsePayerSig(c.header), c.name).toBeNull();
    for (const c of v.attestedProof.valid) {
      const a = decodeAttestedProof(c.header);
      expect(Buffer.from(c.header, 'base64').toString('utf8')).toBe(c.json);
      expect(a.signer).toBe(c.signer);
      const digest = proofDigest(eip712Domain(BigInt(c.chainId), c.verifyingContract as Address), a.proof);
      expect(await recoverDigestSigner(digest, a.signature), c.name).toBe(c.signer);
    }
    for (const c of v.attestedProof.invalid) expect(() => decodeAttestedProof(c.header), c.name).toThrow();
  });
});
