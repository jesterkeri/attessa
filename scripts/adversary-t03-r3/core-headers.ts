// Reads [[kind, value], ...] from argv[2]; prints core's accept (true) / reject (false) for each.
import { readFileSync } from 'node:fs';
import { decodeAttestedProof, isRequestIdHeader, isRetryAfterHeader, parsePayerSig } from '../../packages/core/src/headers.ts';
const cases: [string, string][] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify(cases.map(([k, v]) => {
  try {
    if (k === 'b32') return isRequestIdHeader(v);
    if (k === 'retry') return isRetryAfterHeader(v);
    if (k === 'payer') { const p = parsePayerSig(v); return p ? `${p.unixSeconds}.${p.signature}` : false; }
    decodeAttestedProof(v); return true;
  } catch { return false; }
})));
