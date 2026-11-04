import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AlreadyUsedError } from '../src/client.ts';
import { spendToday } from '../src/ledger.ts';
import { makeWorld, PRICE, type World } from './fakes/world.ts';

// SPEC §7 "refused / uncertain -> final": settled on chain and no result -> settled_after_refusal for a refused call,
// paid_but_rejected{missing_proof} for an uncertain one. getResult on a call whose settlement the SDK has recorded
// (here by cancelAuthorization's AlreadyUsedError) decides the same way when the gateway answers result_not_found.

let w: World;
afterEach(async () => w?.close());

const entries = (dir: string) =>
  readFileSync(join(dir, 'pending.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const evidence = (dir: string) =>
  readFileSync(join(dir, 'evidence.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('getResult on a settled call the gateway holds no answer for', () => {
  it('a refused call ends settled_after_refusal: terminal ledger entry, evidence row, spend counted', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'refuse_but_settle' };
    const r0 = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r0.outcome).toBe('refused');
    const err = await w.client.cancelAuthorization(r0.requestId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlreadyUsedError);
    const tx = (err as AlreadyUsedError).tx;
    expect(entries(w.dataDir)[0]).toMatchObject({ state: 'refused', settlementTx: tx });

    const r = await w.client.getResult(r0.requestId);
    expect(r).toMatchObject({ outcome: 'settled_after_refusal', settlementTx: tx, code: 'proof_rejected' });
    expect(entries(w.dataDir)[0]).toMatchObject({ state: 'settled_after_refusal', settlementTx: tx });
    expect(evidence(w.dataDir).at(-1)).toMatchObject({ outcome: 'settled_after_refusal', settlementTx: tx });
    expect(spendToday(entries(w.dataDir), w.chain.asset, Date.now())).toBe(PRICE);
    expect(await w.client.listPending()).toHaveLength(0);
    // Decided: asked again, the stored outcome, with no new evidence row.
    const rows = evidence(w.dataDir).length;
    expect((await w.client.getResult(r0.requestId)).outcome).toBe('settled_after_refusal');
    expect(evidence(w.dataDir)).toHaveLength(rows);
  });

  it('an uncertain call ends paid_but_rejected{missing_proof}, as reconcilePending decides it', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'drop_after_settle', noResults: true };
    const r0 = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r0.outcome).toBe('uncertain');
    const err = await w.client.cancelAuthorization(r0.requestId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlreadyUsedError);
    const tx = (err as AlreadyUsedError).tx;

    const r = await w.client.getResult(r0.requestId);
    expect(r).toMatchObject({ outcome: 'paid_but_rejected', check: 'missing_proof', settlementTx: tx });
    expect(entries(w.dataDir)[0]).toMatchObject({ state: 'paid_but_rejected', settlementTx: tx });
    expect(evidence(w.dataDir).at(-1)).toMatchObject({ outcome: 'paid_but_rejected', check: 'missing_proof' });
  });

  it('with no settlement recorded, result_not_found decides nothing: the call stays open', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'refuse' };
    const r0 = await w.client.payAndVerify(w.url, { body: w.body });
    const r = await w.client.getResult(r0.requestId);
    expect(r).toMatchObject({ outcome: 'refused', code: 'result_not_found' });
    expect(r.settlementTx).toBeUndefined();
    expect(entries(w.dataDir)[0].state).toBe('refused');
  });
});
