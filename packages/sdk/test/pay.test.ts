import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { jcs, requestHash } from '@attessa/core';
import { makeWorld, PRICE, type World } from './fakes/world.ts';

let w: World;
afterEach(async () => w?.close());

const lines = (dir: string, f: string) =>
  readFileSync(join(dir, f), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe('payAndVerify happy path (V0-V12)', () => {
  it('verifies, settles once, and records the ledger entry and evidence row', async () => {
    w = await makeWorld();
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('verified');
    expect(r.check).toBeUndefined();
    expect(r.signer).toBe(w.enclave.address.toLowerCase());
    expect(r.amount).toBe(PRICE);
    expect(r.payTo).toBe(w.payTo);
    expect(r.inputsChecked).toBe(true);
    expect(r.ownerClaimedSource).toBe('github.com/acme/risk@a1b2c3d');
    expect(r.selfVerifiedOwner).toBe(false);
    expect(new TextDecoder().decode(r.response)).toContain('"verdict":"allow"');
    expect(w.transferSignatures()).toBe(1);
    expect(w.gw.paid).toHaveLength(1);

    const [entry] = lines(w.dataDir, 'pending.jsonl');
    expect(entry.state).toBe('verified');
    expect(entry.requestId).toBe(r.requestId);
    expect(entry.nonce).toBe(w.gw.paid[0]!.ctx.nonce);
    expect(entry.settlementTx).toBe(r.settlementTx);
    expect(entry.requestHash).toBe(requestHash('POST', '/v1/evaluate', new TextEncoder().encode(w.body)));

    const ev = lines(w.dataDir, 'evidence.jsonl');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      v: '1',
      outcome: 'verified',
      requestId: r.requestId,
      agentId: '7',
      amount: '20000',
      settlementTx: r.settlementTx,
      signer: w.enclave.address.toLowerCase(),
      releaseId: w.releaseId,
      inputsChecked: true,
      via: 'gateway',
    });
    expect(ev[0].responseHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ev[0].inputsHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('builds the x402 v2 payment exactly: accepted equals the offered entry, chain-time window, valid EIP-3009 signature', async () => {
    w = await makeWorld();
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('verified');
    const p = w.gw.paid[0]!;
    expect(p.acceptedMatches).toBe(true);
    expect(p.signatureOk).toBe(true);
    expect(p.payload.x402Version).toBe(2);
    const auth = (p.payload.payload as { authorization: Record<string, string> }).authorization;
    expect(auth.to).toBe(w.payTo);
    expect(auth.value).toBe('20000');
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const entry = lines(w.dataDir, 'pending.jsonl')[0];
    // V8: validAfter = chainNow − 60, validBefore = chainNow + 120, chainNow = the signing block's time.
    expect(p.validBefore - p.validAfter).toBe(180n);
    expect(BigInt(entry.signedAtChain)).toBe(p.validAfter + 60n);
    expect(w.chain.blockAt(BigInt(entry.signedAtBlock))!.timestamp).toBe(BigInt(entry.signedAtChain));
    // The payload is canonical JSON and the request id is the one sent on both requests.
    expect(p.ctx.requestId).toBe(r.requestId);
  });

  it('uses a buyer-chosen requestId and refuses to reuse it once in the ledger', async () => {
    w = await makeWorld();
    const id = `0x${'5d'.repeat(32)}` as const;
    const r = await w.client.payAndVerify(w.url, { body: w.body, requestId: id });
    expect(r).toMatchObject({ outcome: 'verified', requestId: id });
    const again = await w.client.payAndVerify(w.url, { body: '{"other":"body"}', requestId: id });
    expect(again).toMatchObject({ outcome: 'stopped', code: 'request_id_conflict' });
    expect(w.transferSignatures()).toBe(1);
  });

  it('202 settle_pending: polls /v1/results every 3 s and ends verified', async () => {
    w = await makeWorld();
    w.gw.behavior = { paid: 'pending', pendingPolls: 2 };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('verified');
    expect(w.sleeps.count).toBeGreaterThanOrEqual(2);
  });

  it('202 that never resolves: uncertain until validBefore + 60, then chain decides (not charged)', async () => {
    w = await makeWorld();
    w.gw.behavior = { paid: 'pending_no_settle' };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('not_charged');
    const entry = lines(w.dataDir, 'pending.jsonl')[0];
    expect(w.chain.blockAt(r.confirmedAtBlock!)!.timestamp).toBeGreaterThan(BigInt(entry.validBefore) + 5n);
  });
});

describe('V0 resume from the pending ledger (INV-14)', () => {
  it('a re-run with the same input resumes and never signs a second authorization', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'drop_after_settle', noResults: true };
    const first = await w.client.payAndVerify(w.url, { body: w.body });
    expect(first.outcome).toBe('uncertain');
    expect(w.transferSignatures()).toBe(1);

    w.gw.behavior = { paid: 'deliver' };
    const second = await w.client.payAndVerify(w.url, { body: w.body });
    expect(second.requestId).toBe(first.requestId);
    expect(second.outcome).toBe('verified');
    expect(w.transferSignatures()).toBe(1);
    expect(w.gw.paid).toHaveLength(1);
  });

  it('newRequest pays again with a fresh requestId', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'html502' };
    const first = await w.client.payAndVerify(w.url, { body: w.body });
    expect(first.outcome).toBe('uncertain');
    w.gw.behavior = { paid: 'deliver' };
    const second = await w.client.payAndVerify(w.url, { body: w.body, newRequest: true });
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.outcome).toBe('verified');
    expect(w.transferSignatures()).toBe(2);
  });

  it('a reserved entry for the same input in another process: waits for it, never calls getResult without a nonce', async () => {
    w = await makeWorld();
    const rh = requestHash('POST', '/v1/evaluate', new TextEncoder().encode(w.body));
    w.client.ledger.reserve(
      {
        v: '1', requestId: `0x${'aa'.repeat(32)}`, origin: w.origin, originHash: w.gw.originHash, method: 'POST', pathAndQuery: '/v1/evaluate',
        requestHash: rh, asset: w.chain.asset, amount: '20000', payTo: w.payTo, payer: w.account.address.toLowerCase() as `0x${string}`,
        nonce: null, signedAtChain: null, signedAtBlock: null, validAfter: null, validBefore: null, agentId: '7', expectedSigner: null,
        state: 'reserved', code: null, settlementTx: null, createdAt: String(Date.now()),
      },
      10n ** 9n,
    );
    const resultsBefore = w.gw.paid.length;
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r).toMatchObject({ outcome: 'stopped', code: 'in_progress' });
    expect(w.sleeps.count).toBe(30);
    expect(w.transferSignatures()).toBe(0);
    expect(w.gw.paid.length).toBe(resultsBefore);
  });
});

describe('header grammar', () => {
  it('PAYMENT-SIGNATURE decodes to JCS', async () => {
    w = await makeWorld();
    await w.client.payAndVerify(w.url, { body: w.body });
    const p = w.gw.paid[0]!;
    expect(jcs(p.payload)).toBe(JSON.stringify(JSON.parse(jcs(p.payload))));
    expect(Object.keys(p.payload).sort()).toEqual(['accepted', 'extensions', 'payload', 'resource', 'x402Version']);
  });
});
