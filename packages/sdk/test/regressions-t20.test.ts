import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, stringToBytes, type Hex } from 'viem';
import { requestHash } from '@attessa/core';
import { Ledger } from '../src/ledger.ts';
import type { PendingEntry } from '../src/types.ts';
import { makeWorld, type World } from './fakes/world.ts';

// Regressions for the T20 adversary pass: the exact SPEC behaviour behind each of its three cases.

let w: World | undefined;
let dir = '';
afterEach(async () => {
  await w?.close();
  w = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function entryFor(world: World, over: Partial<PendingEntry>): PendingEntry {
  return {
    v: '1', requestId: `0x${'aa'.repeat(32)}`, origin: world.origin, originHash: world.gw.originHash, method: 'POST',
    pathAndQuery: '/v1/evaluate', requestHash: requestHash('POST', '/v1/evaluate', new TextEncoder().encode(world.body)),
    asset: world.chain.asset, amount: '20000', payTo: world.payTo, payer: world.account.address.toLowerCase() as Hex,
    nonce: null, signedAtChain: null, signedAtBlock: null, validAfter: null, validBefore: null, agentId: '7', expectedSigner: null,
    state: 'reserved', code: null, settlementTx: null, createdAt: String(Date.now()), ...over,
  };
}

describe('INV-14: one ledger record per requestId, decided under the V6 lock', () => {
  it('a requestId taken by another process after the V0 check is refused at V6, before any signature', async () => {
    w = await makeWorld({ waitForExpiry: false });
    const world = w;
    const requestId = keccak256(stringToBytes(`taken-${Math.random()}`));
    // Another process writes an entry with this requestId (for another input) while this call is at V2,
    // i.e. after its own V0 and requestId checks passed.
    world.gw.behavior = {
      unpaid: () => {
        new Ledger(world.dataDir).reserve(entryFor(world, { requestId, requestHash: `0x${'77'.repeat(32)}` }), 10n ** 9n);
        return false;
      },
    };
    const r = await world.client.payAndVerify(world.url, { body: world.body, requestId });
    expect(r).toMatchObject({ outcome: 'stopped', code: 'request_id_conflict' });
    expect(world.transferSignatures()).toBe(0);
    expect(world.gw.paid).toHaveLength(0);
    const ids = new Ledger(world.dataDir).list().map((e) => e.requestId);
    expect(ids).toEqual([requestId]);
  });

  it('the same input opened by another process after the V0 check is resumed at V6, never signed twice', async () => {
    w = await makeWorld();
    const world = w;
    world.gw.behavior = {
      unpaid: () => {
        new Ledger(world.dataDir).reserve(entryFor(world, {}), 10n ** 9n);
        return false;
      },
    };
    const r = await world.client.payAndVerify(world.url, { body: world.body });
    // The other process's entry stays `reserved`: V0 waits 30 s for it, then reports it in progress.
    expect(r).toMatchObject({ outcome: 'stopped', code: 'in_progress' });
    expect(world.transferSignatures()).toBe(0);
    expect(new Ledger(world.dataDir).list()).toHaveLength(1);
  });

  it('two clients on one dataDir with one requestId and different bodies: exactly one signs', async () => {
    w = await makeWorld({ waitForExpiry: false });
    const requestId = keccak256(stringToBytes(`race-${Math.random()}`));
    const other = w.mkClient();
    const otherBody = JSON.stringify({ ...JSON.parse(w.body), amount: '20001' });
    const [a, b] = await Promise.all([
      w.client.payAndVerify(w.url, { body: w.body, requestId }),
      other.payAndVerify(w.url, { body: otherBody, requestId }),
    ]);
    expect(w.transferSignatures()).toBe(1);
    expect([a, b].filter((r) => r.outcome === 'stopped').map((r) => r.code)).toEqual(['request_id_conflict']);
    const ids = new Ledger(w.dataDir).list().map((e) => e.requestId);
    expect(ids).toEqual([requestId]);
  });

  it('Ledger.reserve refuses an existing requestId, and no write can produce two records with one id', () => {
    dir = mkdtempSync(join(tmpdir(), 'attessa-ledger-'));
    const l = new Ledger(dir);
    const base = {
      v: '1', requestId: `0x${'01'.repeat(32)}`, origin: 'https://risk.example', originHash: `0x${'11'.repeat(32)}`, method: 'POST',
      pathAndQuery: '/v1/evaluate', requestHash: `0x${'22'.repeat(32)}`, asset: '0x01c5c0122039549ad1493b8220cabedd739bc44e', amount: '1',
      payTo: '0x2222222222222222222222222222222222222222', payer: '0x3333333333333333333333333333333333333333', nonce: null,
      signedAtChain: null, signedAtBlock: null, validAfter: null, validBefore: null, agentId: '7', expectedSigner: null,
      state: 'reserved', code: null, settlementTx: null, createdAt: String(Date.now()),
    } as PendingEntry;
    expect(l.reserve(base, 10n ** 9n)).toBe('reserved');
    expect(l.reserve({ ...base, requestHash: `0x${'33'.repeat(32)}` }, 10n ** 9n)).toBe('request_id_conflict');
    expect(() => l.withLock((es) => ({ entries: [...es, es[0]!], result: undefined }))).toThrow(/share one requestId/);
    expect(l.list()).toHaveLength(1);
  });
});

describe('V10 inputs block: a fabricated block is a ProofCheck, an RPC failure is not', () => {
  it('a block read that fails at or below the settlement block stays uncertain{rpc_unavailable}', async () => {
    w = await makeWorld({ waitForExpiry: false });
    const world = w;
    let inputsBlock: string | undefined;
    world.gw.behavior = {
      paid: 'deliver',
      inputs: (i) => {
        inputsBlock = (i.block as { number: string }).number;
        return i;
      },
    };
    const real = world.chain.request.bind(world.chain);
    world.chain.request = async (method, params) => {
      if (method === 'eth_getBlockByNumber' && inputsBlock !== undefined && params?.[0] === `0x${BigInt(inputsBlock).toString(16)}`)
        throw new Error('header not found');
      return real(method, params);
    };
    const r = await world.client.payAndVerify(world.url, { body: world.body });
    expect({ outcome: r.outcome, code: r.code }).toEqual({ outcome: 'uncertain', code: 'rpc_unavailable' });
    expect(r.check).toBeUndefined();
  });
});

describe('V9: only an own §10 code makes a refusal', () => {
  for (const error of ['toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    it(`a 502 whose "error" is "${error}" is uncertain`, async () => {
      w = await makeWorld({ waitForExpiry: false });
      w.gw.behavior = { paid: 'refuse', refuseWith: { status: 502, error } };
      const r = await w.client.payAndVerify(w.url, { body: w.body });
      expect(r.outcome).toBe('uncertain');
      expect(new Ledger(w.dataDir).list()[0]!.state).toBe('uncertain');
    });
  }
});

describe('INV-13: a terminal paid_but_rejected keeps its ProofCheck', () => {
  it('getResult after paid_but_rejected{missing_proof} still reports the check', async () => {
    w = await makeWorld();
    w.gw.behavior = { paid: 'proxy502_after_settle', noResults: true };
    const r0 = await w.client.payAndVerify(w.url, { body: w.body });
    expect({ outcome: r0.outcome, code: r0.code, check: r0.check }).toEqual({ outcome: 'paid_but_rejected', code: 'proof_rejected', check: 'missing_proof' });
    expect(new Ledger(w.dataDir).get(r0.requestId)!.code).toBe('proof_rejected{missing_proof}');
    const r = await w.client.getResult(r0.requestId);
    expect({ outcome: r.outcome, check: r.check }).toEqual({ outcome: 'paid_but_rejected', check: 'missing_proof' });
  });
});

describe('SPEC §7: a refused call stays refused until the chain decides it', () => {
  it('an RPC error while verifying a refused call keeps it refused; with no result it ends settled_after_refusal', async () => {
    w = await makeWorld({ waitForExpiry: false });
    const world = w;
    let inputsBlock: string | undefined;
    world.gw.behavior = {
      paid: 'refuse_with_result',
      inputs: (i) => {
        inputsBlock = (i.block as { number: string }).number;
        return i;
      },
    };
    const r0 = await world.client.payAndVerify(world.url, { body: world.body });
    expect(r0).toMatchObject({ outcome: 'refused', code: 'settle_failed' });
    const real = world.chain.request.bind(world.chain);
    let failing = true;
    world.chain.request = async (method, params) => {
      if (failing && method === 'eth_getBlockByNumber' && inputsBlock !== undefined && params?.[0] === `0x${BigInt(inputsBlock).toString(16)}`)
        throw new Error('header not found');
      return real(method, params);
    };
    const r1 = await world.client.getResult(r0.requestId);
    expect({ outcome: r1.outcome, code: r1.code }).toEqual({ outcome: 'refused', code: 'rpc_unavailable' });
    expect(new Ledger(world.dataDir).get(r0.requestId)).toMatchObject({ state: 'refused', code: 'settle_failed{expired}' });
    failing = false;
    world.gw.behavior = { noResults: true };
    const r = await world.client.confirmNotCharged(r0.requestId);
    expect({ outcome: r.outcome, code: r.code }).toEqual({ outcome: 'settled_after_refusal', code: 'settle_failed' });
  });
});
