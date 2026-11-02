import { afterEach, describe, expect, it } from 'vitest';
import type { Progress } from '../src/types.ts';
import { makeWorld, PRICE, type World } from './fakes/world.ts';

// ClientOptions.onProgress: the moments the CLI prints a line for (FLOWS §6), and `--dry-run`.

let w: World;
afterEach(async () => w?.close());

async function run(setup: (w: World) => void, onProgress?: (e: Progress) => void | 'stop') {
  w = await makeWorld();
  setup(w);
  const events: Progress[] = [];
  const client = w.mkClient({
    onProgress: (e) => {
      events.push(e);
      return onProgress?.(e);
    },
  });
  const r = await client.payAndVerify(w.url, { body: w.body });
  return { r, events, kinds: events.map((e) => e.kind), client };
}

describe('payAndVerify progress events', () => {
  it('happy path: one authorizing event, after liveness and before signing, with what was checked', async () => {
    let signedBefore = -1;
    const { r, events, kinds } = await run(() => {}, () => {
      signedBefore = w.transferSignatures();
    });
    expect(r.outcome).toBe('verified');
    expect(kinds).toEqual(['authorizing']);
    expect(signedBefore).toBe(0);
    const a = events[0] as Extract<Progress, { kind: 'authorizing' }>;
    expect(a.amount).toBe(PRICE);
    expect(a.maxAmount).toBe(100_000n);
    expect(a.signer).toBe(w.enclave.address.toLowerCase());
    expect(a.releaseId).toBe(w.releaseId);
    expect(a.endpoint.agentId).toBe(7n);
    expect(a.ownerClaimedSource).toBe('github.com/acme/risk@a1b2c3d');
    expect(a.quoteMs).toBeGreaterThanOrEqual(0);
  });

  it("'stop' from authorizing (--dry-run): stopped dry_run, nothing signed, nothing sent, reservation released", async () => {
    const { r, kinds, client } = await run(() => {}, (e) => (e.kind === 'authorizing' ? 'stop' : undefined));
    expect(r.outcome).toBe('stopped');
    expect(r.code).toBe('dry_run');
    expect(kinds).toEqual(['authorizing']);
    expect(w.transferSignatures()).toBe(0);
    expect(w.gw.paid).toHaveLength(0);
    expect(await client.listPending()).toEqual([]);
    expect(client.ledger.list()).toEqual([]);
  });

  // Adversary T21 r3: the CLI's price lines can fail to print (a closed stdout). The handler's throw is "no answer",
  // so ClientOptions.dryRun is the stop, independent of onProgress.
  it('dryRun: stopped dry_run before signing even when onProgress throws', async () => {
    w = await makeWorld();
    const client = w.mkClient({
      dryRun: true,
      onProgress: () => {
        throw new Error('EPIPE: broken pipe, write');
      },
    });
    const r = await client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('stopped');
    expect(r.code).toBe('dry_run');
    expect(w.transferSignatures()).toBe(0);
    expect(w.gw.paid).toHaveLength(0);
    expect(client.ledger.list()).toEqual([]);
  });

  it('dryRun with no onProgress at all: still stopped before signing', async () => {
    w = await makeWorld();
    const r = await w.mkClient({ dryRun: true }).payAndVerify(w.url, { body: w.body });
    expect(r).toMatchObject({ outcome: 'stopped', code: 'dry_run' });
    expect(w.transferSignatures()).toBe(0);
    expect(w.gw.paid).toHaveLength(0);
  });

  it('refused: a refused event with the code, then one waiting event with chain time before validBefore', async () => {
    const { r, events, kinds } = await run((w) => (w.gw.behavior = { paid: 'refuse' }));
    expect(r.outcome).toBe('not_charged');
    expect(kinds).toEqual(['authorizing', 'refused', 'waiting']);
    const ref = events[1] as Extract<Progress, { kind: 'refused' }>;
    expect(ref.code).toBe('proof_rejected');
    expect(ref.detail).toBe('response_hash_mismatch');
    const wait = events[2] as Extract<Progress, { kind: 'waiting' }>;
    expect(wait.entry.state).toBe('refused');
    expect(wait.chainNow < BigInt(wait.entry.validBefore!)).toBe(true);
  });

  it('a proxy 502 after signing: uncertain, then waiting', async () => {
    const { r, kinds } = await run((w) => (w.gw.behavior = { paid: 'html502' }));
    expect(r.outcome).toBe('not_charged');
    expect(kinds).toEqual(['authorizing', 'uncertain', 'waiting']);
  });

  it('202: settle_pending, with the tx when PAYMENT-RESPONSE carries it', async () => {
    const { r, events, kinds } = await run((w) => (w.gw.behavior = { paid: 'pending', pendingTx: true }));
    expect(r.outcome).toBe('verified');
    expect(kinds).toEqual(['authorizing', 'settle_pending']);
    expect((events[1] as Extract<Progress, { kind: 'settle_pending' }>).tx).toBe(r.settlementTx);
  });

  it('V0: re-running the same input resumes it (resuming event) and never pays again', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'pending_no_settle' };
    const first = await w.client.payAndVerify(w.url, { body: w.body });
    expect(first.outcome).toBe('uncertain');
    const events: Progress[] = [];
    const again = await w.mkClient({ onProgress: (e) => void events.push(e) }).payAndVerify(w.url, { body: w.body });
    expect(events.map((e) => e.kind)).toEqual(['resuming']);
    expect(events[0]!.kind === 'resuming' && events[0]!.entry.requestId).toBe(first.requestId);
    expect(again.requestId).toBe(first.requestId);
    expect(w.transferSignatures()).toBe(1);
  });
});

describe('payAndVerify with a throwing progress handler', () => {
  it.each(['authorizing', 'refused', 'waiting'] as const)('a handler that throws on %s changes nothing: same outcome, ledger and evidence as with no handler', async (kind) => {
    const { r, kinds } = await run(
      (w) => (w.gw.behavior = { paid: 'refuse' }),
      (e) => {
        if (e.kind === kind) throw new TypeError('handler bug');
      },
    );
    expect(r.outcome).toBe('not_charged');
    expect(kinds).toEqual(['authorizing', 'refused', 'waiting']);
    expect(w.transferSignatures()).toBe(1);
    const ledger = w.mkClient().ledger;
    expect(ledger.list().map((e) => [e.state, e.code])).toEqual([['not_charged', 'proof_rejected{response_hash_mismatch}']]);
    expect(ledger.readEvidence().map((e) => e.outcome)).toEqual(['refused', 'not_charged']);
  });

  it('the same refused call with no handler leaves the same ledger and evidence', async () => {
    w = await makeWorld();
    w.gw.behavior = { paid: 'refuse' };
    expect((await w.client.payAndVerify(w.url, { body: w.body })).outcome).toBe('not_charged');
    expect(w.client.ledger.list().map((e) => [e.state, e.code])).toEqual([['not_charged', 'proof_rejected{response_hash_mismatch}']]);
    expect(w.client.ledger.readEvidence().map((e) => e.outcome)).toEqual(['refused', 'not_charged']);
  });
});
