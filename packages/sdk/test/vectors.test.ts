import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { jcs, proofFromJson } from '@attessa/core';
import { Chain } from '../src/chain.ts';
import type { PendingEntry } from '../src/types.ts';
import { verifyPaid } from '../src/verify.ts';
import { FakeChain } from './fakes/chain.ts';

// INV-13 with vectors/eip712.json: every signature vector over the "sepolia" proof, put through the
// SDK's V10 recovery step. A valid signature gets past recovery (and then fails on the response
// bytes, which the vector doesn't carry); every invalid one, and a valid signature from a key other
// than the header's signer, is bad_signature.

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const v = JSON.parse(readFileSync(fileURLToPath(new URL('../../../vectors/eip712.json', import.meta.url)), 'utf8')) as Any;
const p0 = v.proof.find((p: Any) => p.name === 'sepolia');
const { name: _n, chainId: _c, verifyingContract, domainSeparator: _d, structHash: _s, digest, ...fields } = p0;
const proof = proofFromJson(fields);
const KEY10 = v.signatures.find((s: Any) => s.name === 'valid, key 10').signer as Address;

const fake = new FakeChain({ chainId: Number(p0.chainId), registry: verifyingContract });
const chain = new Chain(fake.transport(), verifyingContract);
const entry: PendingEntry = {
  v: '1', requestId: proof.requestId, origin: 'https://risk.example', originHash: `0x${'00'.repeat(32)}`, method: 'POST',
  pathAndQuery: '/v1/evaluate', requestHash: proof.requestHash, asset: fake.asset, amount: '20000',
  payTo: '0x1111111111111111111111111111111111111111', payer: '0x2222222222222222222222222222222222222222',
  nonce: proof.paymentId, signedAtChain: proof.issuedAt.toString(), signedAtBlock: '1000', validAfter: '0', validBefore: '0',
  agentId: proof.agentId.toString(), expectedSigner: null, state: 'signed', code: null, settlementTx: null, createdAt: '0',
};
const settlement = { tx: `0x${'ab'.repeat(32)}` as Hex, blockNumber: 1000n, timestamp: proof.issuedAt };
const header = (signature: string, signer: string) =>
  Buffer.from(jcs({ proof: fields, signature, signer })).toString('base64');
const run = (signature: string, signer: string) =>
  verifyPaid(chain, Number(p0.chainId), entry, new Uint8Array([1]), header(signature, signer), settlement, async () => {});

describe('vectors/eip712.json signatures through V10 recovery', () => {
  for (const s of v.signatures.filter((x: Any) => x.digest === digest)) {
    it(`${s.name}: ${s.valid ? 'recovers' : 'bad_signature'}`, async () => {
      const r = await run(s.signature, s.valid ? s.signer : KEY10);
      if (s.valid) expect(r).toMatchObject({ ok: false, check: 'response_hash_mismatch', signer: s.signer });
      else expect(r).toMatchObject({ ok: false, check: 'bad_signature' });
    });
  }

  it("another key's valid signature with the header naming key 10 → bad_signature", async () => {
    const other = v.signatures.find((x: Any) => x.name === 'another key signs the same digest');
    expect(await run(other.signature, KEY10)).toMatchObject({ ok: false, check: 'bad_signature' });
  });

  it('the vector proof has a 600 s TTL and its digest is the one signed', () => {
    expect(proof.expiresAt - proof.issuedAt).toBe(600n);
    expect(v.signatures.filter((x: Any) => x.digest === digest).length).toBeGreaterThanOrEqual(5);
  });
});
