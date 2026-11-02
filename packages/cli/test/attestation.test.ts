import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { hintPlan, parseAttestation } from '../src/attestation.ts';
import { FakeNitroChain } from './fake-nitro.ts';

describe('seller attestation parsing (signer register/renew input)', () => {
  it('reads timestamp, PCRs, public_key, user_data and the chain from a COSE_Sign1 document', () => {
    const chain = new FakeNitroChain();
    const userData = Buffer.alloc(160, 7);
    const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]);
    const { document, pcrs } = chain.attest({ userData, publicKey, timestampMs: 1_793_000_000_123n });
    const a = parseAttestation(document);
    expect(a.timestampMs).toBe(1_793_000_000_123n);
    expect(a.pcrs.get(0)).toBe(toHex(pcrs[0]));
    expect(a.pcrs.get(2)).toBe(toHex(pcrs[2]));
    expect(a.userData).toBe(toHex(userData));
    expect(a.publicKey).toBe(toHex(publicKey));
    expect(a.cabundle).toHaveLength(4);
    // base64 and hex files are accepted too
    expect(parseAttestation(Buffer.from(document.toString('base64'))).raw.equals(document)).toBe(true);
    expect(parseAttestation(Buffer.from(`0x${document.toString('hex')}\n`)).raw.equals(document)).toBe(true);
  });

  it('plans one cache step per non-root certificate, each parented by the previous cache key, with hints', () => {
    const chain = new FakeNitroChain();
    const notAfter = new Date('2026-11-01T12:00:00Z');
    const { document } = chain.attest({ userData: null, publicKey: null, timestampMs: 1n, certsNotAfter: notAfter });
    const a = parseAttestation(document);
    const plan = hintPlan(a);
    expect(plan.rootHash).toBe(keccak256(a.cabundle[0]!));
    expect(plan.certs.map((c) => c.kind)).toEqual(['ca', 'ca', 'ca', 'leaf']);
    expect(plan.certs[0]!.parentCertHash).toBe(plan.rootHash);
    for (let i = 1; i < 4; i++) expect(plan.certs[i]!.parentCertHash).toBe(plan.certs[i - 1]!.certHash);
    for (const c of plan.certs) {
      expect(c.notAfter).toBe(BigInt(notAfter.getTime() / 1000));
      expect((c.hints.length - 2) / 2 % 48).toBe(0);
      expect(c.hints.length).toBeGreaterThan(2);
    }
    expect((plan.attestationHints.length - 2) / 2 % 48).toBe(0);
  });

  it('a tampered document signature fails hint generation (it verifies the signature off chain)', () => {
    const { document } = new FakeNitroChain().attest({ userData: null, publicKey: null, timestampMs: 1n });
    const bad = Buffer.from(document);
    bad[bad.length - 1] ^= 1;
    expect(() => hintPlan(parseAttestation(bad))).toThrow(/verification failed|rejected/);
  });

  it('parses the real AWS Nitro fixture from nitro-validator and plans its real chain', () => {
    const root = fileURLToPath(new URL('../../../contracts/lib/nitro-validator/', import.meta.url));
    const src = readFileSync(`${root}test/hinted/HintedNitroAttestation.t.sol`, 'utf8');
    const m = /function _realAttestationB64\(\)[\s\S]*?return "([^"]+)";/.exec(src);
    expect(m).not.toBeNull();
    const { repairMissingPublicKeyBytes } = createRequire(import.meta.url)(`${root}tools/nitro_attestation_input.js`) as {
      repairMissingPublicKeyBytes: (b: Buffer) => Buffer;
    };
    const doc = repairMissingPublicKeyBytes(Buffer.from(m![1]!, 'base64'));
    const a = parseAttestation(doc);
    // OPEN-QUESTIONS (design review r2): PCR0-2 non-zero, public_key null, user_data 20 bytes, timestamp 1767472867402 ms.
    expect(a.timestampMs).toBe(1767472867402n);
    expect(a.publicKey).toBeNull();
    expect((a.userData!.length - 2) / 2).toBe(20);
    for (const i of [0, 1, 2]) expect(a.pcrs.get(i)).not.toMatch(/^0x0+$/);
    const plan = hintPlan(a);
    // The pinned AWS root (CertManager.ROOT_CA_CERT_HASH).
    expect(plan.rootHash).toBe('0x311d96fcd5c5e0ccf72ef548e2ea7d4c0cd53ad7c4cc49e67471aed41d61f185');
    expect(plan.certs.at(-1)!.kind).toBe('leaf');
  });
});
