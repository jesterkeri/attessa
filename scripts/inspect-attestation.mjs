#!/usr/bin/env node
// T12 (SPEC §4.1, Spike S2): prints what an NSM attestation carries and fails unless public_key is 65 bytes,
// user_data 160, PCR0/1/2 non-zero and the timestamp within 60 s of now. Uses core's parser from source (Node 22.18+ strips types; needs `pnpm install`).
// Usage: node scripts/inspect-attestation.mjs <att.bin>   (raw COSE bytes, or a file of base64 or 0x-hex)
import { readFileSync } from 'node:fs';
import { parseAttestation } from '../packages/core/src/attestation.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/inspect-attestation.mjs <att.bin>');
  process.exit(2);
}
let a;
try {
  a = parseAttestation(readFileSync(file));
} catch (e) {
  console.log(`FAIL not an attestation: ${e.message}`);
  process.exit(1);
}
const len = (h) => (h === null ? 0 : (h.length - 2) / 2);
const nonZero = (h) => h !== undefined && /[1-9a-f]/i.test(h.slice(2));
const ageS = Math.round((Date.now() - Number(a.timestampMs)) / 1000);
const checks = [
  [`public_key length ${len(a.publicKey)}`, len(a.publicKey) === 65],
  [`user_data length ${len(a.userData)}`, len(a.userData) === 160],
  ...[0, 1, 2].map((i) => [`PCR${i} ${a.pcrs.get(i) ?? 'missing'}`, nonZero(a.pcrs.get(i))]),
  [`timestamp ${new Date(Number(a.timestampMs)).toISOString()} (${ageS} s ago)`, Math.abs(ageS) <= 60],
];
for (const [line, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
