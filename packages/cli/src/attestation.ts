import { createRequire } from 'node:module';
import type { ParsedAttestation } from '@attessa/core';
import { keccak256, toHex, type Hex } from 'viem';

/**
 * The certificate cache keys and inverse hints `signer register|renew` submit for a Nitro attestation
 * (parsed by @attessa/core). The registry and CertManager re-check everything; this only predicts their answer.
 */

interface P384Hints {
  collectAttestationHintBytes(attestation: Buffer, leafPubKey: Buffer): Buffer;
  collectCertSignatureHintBytes(cert: Buffer, parentPubKey: Buffer): Buffer;
  parseCertPublicKey(cert: Buffer): Buffer;
  parseCertTbs(cert: Buffer): Buffer;
}

// The vendored generator sits next to src/ and dist/, so this path holds for both.
const p384 = createRequire(import.meta.url)('../vendor/p384_hints.cjs') as P384Hints;

export { attestationBytes, parseAttestation, type ParsedAttestation } from '@attessa/core';

// ---- Certificate chain plan

export interface CertStep {
  kind: 'ca' | 'leaf';
  /** 1-based position below the root: 1 = regional CA … last = leaf. */
  index: number;
  cert: Hex;
  /** CertManager cache key: keccak256(tbsCertificate). */
  certHash: Hex;
  parentCertHash: Hex;
  hints: Hex;
  /** notAfter of the certificate, unix seconds. */
  notAfter: bigint;
}

export interface HintPlan {
  rootHash: Hex;
  certs: CertStep[];
  attestationHints: Hex;
}

/** Cache keys and inverse hints for every non-root certificate, then the document signature's hints. */
export function hintPlan(a: ParsedAttestation): HintPlan {
  const root = a.cabundle[0]!;
  const rootHash = keccak256(root);
  let parentHash = rootHash;
  let parentKey = p384.parseCertPublicKey(root);
  const certs: CertStep[] = [];
  const chain: Array<{ cert: Buffer; kind: 'ca' | 'leaf' }> = [
    ...a.cabundle.slice(1).map((cert) => ({ cert, kind: 'ca' as const })),
    { cert: a.certificate, kind: 'leaf' },
  ];
  chain.forEach(({ cert, kind }, i) => {
    const certHash = keccak256(p384.parseCertTbs(cert));
    certs.push({
      kind,
      index: i + 1,
      cert: toHex(cert),
      certHash,
      parentCertHash: parentHash,
      hints: toHex(p384.collectCertSignatureHintBytes(cert, parentKey)),
      notAfter: certNotAfter(cert),
    });
    parentHash = certHash;
    parentKey = p384.parseCertPublicKey(cert);
  });
  return { rootHash, certs, attestationHints: toHex(p384.collectAttestationHintBytes(a.raw, parentKey)) };
}

// ---- DER: notAfter of an X.509 certificate

function der(bytes: Uint8Array, start: number): { tag: number; contentStart: number; end: number } {
  const tag = bytes[start]!;
  let len = bytes[start + 1]!;
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('DER: bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[start + 2 + i]!;
    hdr += n;
  }
  const end = start + hdr + len;
  if (end > bytes.length) throw new Error('DER: out of bounds');
  return { tag, contentStart: start + hdr, end };
}

function derTime(bytes: Uint8Array, node: { tag: number; contentStart: number; end: number }): bigint {
  const s = Buffer.from(bytes.subarray(node.contentStart, node.end)).toString('ascii');
  // UTCTime YYMMDDHHMMSSZ (years 1950-2049) or GeneralizedTime YYYYMMDDHHMMSSZ.
  const m = node.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) throw new Error('DER: bad time');
  let year = Number(m[1]);
  if (node.tag === 0x17) year += year < 50 ? 2000 : 1900;
  return BigInt(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) / 1000);
}

export function certNotAfter(cert: Uint8Array): bigint {
  const root = der(cert, 0);
  const tbs = der(cert, root.contentStart);
  let p = der(cert, tbs.contentStart);
  if (p.tag === 0xa0) p = der(cert, p.end); // version, then serial
  const sigAlg = der(cert, p.end);
  const issuer = der(cert, sigAlg.end);
  const validity = der(cert, issuer.end);
  const notBefore = der(cert, validity.contentStart);
  return derTime(cert, der(cert, notBefore.end));
}
