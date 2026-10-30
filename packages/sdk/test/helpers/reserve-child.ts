// Run by ledger.test.ts as a separate node process (INV-19). argv: dataDir tag count amount cap startAtMs
import { randomBytes } from 'node:crypto';
import { Ledger } from '../../src/ledger.ts';

const [dir, tag, count, amount, cap, startAt] = process.argv.slice(2) as [string, string, string, string, string, string];
const ledger = new Ledger(dir);
// Start together, so the two processes really overlap.
while (Date.now() < Number(startAt)) {
  /* spin */
}
let reserved = 0;
for (let i = 0; i < Number(count); i++) {
  const r = ledger.reserve(
    {
      v: '1',
      requestId: `0x${randomBytes(32).toString('hex')}`,
      origin: 'https://risk.example',
      originHash: `0x${'11'.repeat(32)}`,
      method: 'POST',
      pathAndQuery: `/v1/evaluate?${tag}=${i}`,
      requestHash: `0x${randomBytes(32).toString('hex')}`,
      asset: '0x01c5c0122039549ad1493b8220cabedd739bc44e',
      amount,
      payTo: '0x2222222222222222222222222222222222222222',
      payer: '0x3333333333333333333333333333333333333333',
      nonce: null,
      signedAtChain: null,
      signedAtBlock: null,
      validAfter: null,
      validBefore: null,
      agentId: '7',
      expectedSigner: null,
      state: 'reserved',
      code: null,
      settlementTx: null,
      createdAt: String(Date.now()),
    },
    BigInt(cap),
  );
  if (r === 'reserved') reserved++;
}
process.stdout.write(JSON.stringify({ tag, reserved }));
