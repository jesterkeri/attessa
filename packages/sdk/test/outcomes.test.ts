import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toFunctionSelector } from 'viem';
import { AlreadyUsedError, createAttestClient } from '../src/client.ts';
import { spendToday } from '../src/ledger.ts';
import { makeWorld, PRICE, type World } from './fakes/world.ts';

let w: World;
afterEach(async () => w?.close());

const entries = (dir: string) =>
  readFileSync(join(dir, 'pending.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const evidence = (dir: string) =>
  readFileSync(join(dir, 'evidence.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Records the block timestamp of every `authorizationState` eth_call. */
function spyAuthState(world: World): bigint[] {
  const reads: bigint[] = [];
  const real = world.chain.request.bind(world.chain);
  world.chain.request = async (method, params) => {
    if (method === 'eth_call') {
      const data = (params![0] as { data: string }).data;
      // authorizationState(address,bytes32) selector
      if (data.startsWith(toFunctionSelector('authorizationState(address,bytes32)'))) {
        const tag = params![1] as string;
        const n = tag === 'latest' ? world.chain.reportedHead.number : BigInt(tag);
        reads.push(world.chain.blockAt(n)!.timestamp);
      }
    }
    return real(method, params);
  };
  (world as unknown as { authReads: bigint[] }).authReads = reads;
  return reads;
}

describe('refused → final (SPEC §7)', () => {
  it('a §10 refusal waits for a block past validBefore + 5, then not_charged from authorizationState == false', async () => {
    w = await makeWorld();
    const reads = spyAuthState(w);
    w.gw.behavior = { paid: 'refuse', refuseWith: { status: 502, error: 'proof_rejected', detail: 'response_hash_mismatch' } };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('not_charged');
    const [e] = entries(w.dataDir);
    const vb = BigInt(e.validBefore);
    expect(w.chain.blockAt(r.confirmedAtBlock!)!.timestamp).toBeGreaterThan(vb + 5n);
    expect(reads.length).toBeGreaterThan(0);
    for (const t of reads) expect(t).toBeGreaterThan(vb + 5n);
    expect(e.state).toBe('not_charged');
    // The refusal and the confirmation are both in evidence, in order.
    expect(evidence(w.dataDir).map((x) => x.outcome)).toEqual(['refused', 'not_charged']);
    expect(evidence(w.dataDir)[0].code).toBe('proof_rejected');
    // Released: today's spend is back to zero.
    expect(spendToday(entries(w.dataDir), w.chain.asset, Date.now())).toBe(0n);
  });

  it('waitForExpiry: false returns refused, never not_charged, and keeps the reservation', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'refuse', refuseWith: { status: 402, error: 'payment_invalid', detail: 'insufficient_funds' } };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r).toMatchObject({ outcome: 'refused', code: 'payment_invalid', detail: 'insufficient_funds' });
    expect(spendToday(entries(w.dataDir), w.chain.asset, Date.now())).toBe(PRICE);
    expect(await w.client.listPending()).toHaveLength(1);
  });

  it('INV-20: with a lagging RPC head, not_charged only from a block whose own timestamp is past validBefore + 5', async () => {
    w = await makeWorld();
    w.chain.advance(20); // registry state older than the lag
    w.chain.headLag = 8;
    const reads = spyAuthState(w);
    w.gw.behavior = { paid: 'refuse' };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('not_charged');
    const vb = BigInt(entries(w.dataDir)[0].validBefore);
    for (const t of reads) expect(t).toBeGreaterThan(vb + 5n);
    expect(w.chain.blockAt(r.confirmedAtBlock!)!.timestamp).toBeGreaterThan(vb + 5n);
  });

  it('INV-20: a settle landing at validBefore − 1 is never reported not_charged (settled_after_refusal)', async () => {
    w = await makeWorld();
    w.chain.advance(20);
    w.chain.headLag = 3;
    w.gw.behavior = { paid: 'refuse', noResults: true };
    let landed = false;
    w.hooks.onSleep = () => {
      const p = w.gw.paid[0];
      if (!p || landed) return;
      if (w.chain.head.timestamp + 1n >= p.validBefore - 1n) {
        // the facilitator's late retry lands in the block at validBefore − 1
        while (w.chain.head.timestamp < p.validBefore - 2n) w.chain.mine();
        w.chain.settle(p.ctx.payer, w.payTo, PRICE, p.ctx.nonce);
        landed = true;
      }
    };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(landed).toBe(true);
    expect(r.outcome).toBe('settled_after_refusal');
    expect(r.code).toBe('proof_rejected');
    expect(r.settlementTx).toMatch(/^0x[0-9a-f]{64}$/);
    // Counted as spend (INV-19).
    expect(spendToday(entries(w.dataDir), w.chain.asset, Date.now())).toBe(PRICE);
  });

  it('settled_after_refusal: the gateway refused with a §10 body but settled anyway, and has no result', async () => {
    w = await makeWorld();
    w.gw.behavior = { paid: 'refuse_but_settle', noResults: true };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('settled_after_refusal');
    const ev = evidence(w.dataDir).at(-1);
    expect(ev).toMatchObject({ outcome: 'settled_after_refusal', settlementTx: r.settlementTx });
  });

  it('refused, yet settled, and the gateway serves a valid result → getResult first → verified', async () => {
    w = await makeWorld();
    w.gw.behavior = { paid: 'refuse_with_result' };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('verified');
    expect(evidence(w.dataDir).map((x) => x.outcome)).toEqual(['refused', 'verified']);
  });

  it('refused, yet settled, with a result that fails V10 → paid_but_rejected{check}', async () => {
    w = await makeWorld();
    w.gw.behavior = { paid: 'refuse_with_result', tamperResponse: (b) => new Uint8Array([...b, 0x20]) };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect({ outcome: r.outcome, check: r.check }).toEqual({ outcome: 'paid_but_rejected', check: 'response_hash_mismatch' });
  });
});

describe('uncertain → final (INV-23)', () => {
  it('a proxy 502 after a real settle → uncertain → chain shows used → getResult → verified', async () => {
    w = await makeWorld();
    w.gw.behavior = { paid: 'proxy502_after_settle' };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('verified');
    expect(evidence(w.dataDir).map((x) => x.outcome)).toEqual(['verified']);
  });

  it('a dropped connection after a real settle → verified', async () => {
    w = await makeWorld();
    w.gw.behavior = { paid: 'drop_after_settle' };
    expect((await w.client.payAndVerify(w.url, { body: w.body })).outcome).toBe('verified');
  });

  it('a non-2xx without a §10 body is uncertain, not refused', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'html502' };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('uncertain');
    expect(entries(w.dataDir)[0].state).toBe('uncertain');
  });

  it('a §10 body for another requestId is not a refusal of this call', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'refuse', refuseWith: { status: 502, error: 'proof_rejected', requestId: `0x${'99'.repeat(32)}` } };
    expect((await w.client.payAndVerify(w.url, { body: w.body })).outcome).toBe('uncertain');
  });

  it('settled but no result retrievable → getResult tried, then paid_but_rejected{missing_proof}', async () => {
    w = await makeWorld();
    w.gw.behavior = { paid: 'proxy502_after_settle', noResults: true };
    const before = w.gw.paid.length;
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect({ outcome: r.outcome, check: r.check }).toEqual({ outcome: 'paid_but_rejected', check: 'missing_proof' });
    expect(w.gw.paid.length).toBe(before + 1);
    expect(spendToday(entries(w.dataDir), w.chain.asset, Date.now())).toBe(PRICE);
  });

  it('uncertain and never settled → not_charged after validBefore + 5', async () => {
    w = await makeWorld();
    w.gw.behavior = { paid: 'html502' };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('not_charged');
  });
});

describe('confirmNotCharged, cancelAuthorization, reconcilePending', () => {
  it('confirmNotCharged waits for a block with timestamp > validBefore + 5', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'refuse' };
    const r0 = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r0.outcome).toBe('refused');
    const reads = spyAuthState(w);
    const r = await w.client.confirmNotCharged(r0.requestId);
    expect(r.outcome).toBe('not_charged');
    const vb = BigInt(entries(w.dataDir)[0].validBefore);
    expect(reads.every((t) => t > vb + 5n)).toBe(true);
    expect(w.chain.blockAt(r.confirmedAtBlock!)!.timestamp).toBeGreaterThan(vb + 5n);
  });

  it('cancelAuthorization voids the authorization now: not_charged on the confirmed cancel', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'refuse' };
    const r0 = await w.client.payAndVerify(w.url, { body: w.body });
    const tx = await w.client.cancelAuthorization(r0.requestId);
    expect(tx).toMatch(/^0x[0-9a-f]{64}$/);
    const e = entries(w.dataDir)[0];
    expect(e.state).toBe('not_charged');
    expect(e.code).toBe('cancelled');
    expect(w.chain.authUsed(w.gw.paid[0]!.ctx.payer, w.gw.paid[0]!.ctx.nonce)).toBe(true);
    expect(spendToday(entries(w.dataDir), w.chain.asset, Date.now())).toBe(0n);
    // A later confirm reads the AuthorizationCanceled log: still not_charged, no wait.
    expect((await w.client.confirmNotCharged(r0.requestId)).outcome).toBe('not_charged');
  });

  it('cancelAuthorization after the payment went through → AlreadyUsedError with the tx', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'refuse_but_settle' };
    const r0 = await w.client.payAndVerify(w.url, { body: w.body });
    await expect(w.client.cancelAuthorization(r0.requestId)).rejects.toBeInstanceOf(AlreadyUsedError);
  });

  it('reconcilePending drives every open entry to an end state', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'refuse' };
    await w.client.payAndVerify(w.url, { body: w.body });
    w.gw.behavior = { paid: 'proxy502_after_settle' };
    await w.client.payAndVerify(w.url, { body: w.body, newRequest: true });
    expect(await w.client.listPending()).toHaveLength(2);
    const c2 = createAttestClient(
      { network: 'local', account: w.account, limits: { usdc: { maxAmountPerCall: 10n ** 6n, dailyCap: 10n ** 7n }, usat: { maxAmountPerCall: 1n, dailyCap: 1n } }, asset: 'usdc', dataDir: w.dataDir, waitForExpiry: true },
      { registry: w.chain.registry, transport: w.chain.transport(), sleep: async (ms) => w.chain.advance(ms / 1000), receiptWaitMs: 2000 },
    );
    const out = await c2.reconcilePending();
    expect(out.map((r) => r.outcome).sort()).toEqual(['not_charged', 'verified']);
    expect(await c2.listPending()).toHaveLength(0);
  });

  it('getResult never re-pays: it only reads /v1/results', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'drop_after_settle', noResults: true };
    const r0 = await w.client.payAndVerify(w.url, { body: w.body });
    const sigs = w.transferSignatures();
    w.gw.behavior = {};
    const r = await w.client.getResult(r0.requestId);
    expect(r.outcome).toBe('verified');
    expect(w.transferSignatures()).toBe(sigs);
    expect(w.gw.paid).toHaveLength(1);
  });
});

