import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { ProofCheck } from '../src/types.ts';
import type { Behavior } from './fakes/gateway.ts';
import { makeWorld, randomAccount, type World } from './fakes/world.ts';

// INV-13: `verified` only if every V10 check passed and V11 found both logs; any failure returns the
// specific ProofCheck. Each case is a gateway that settles and then delivers one bad thing, so the
// check runs after settlement and the call ends paid_but_rejected{check}.

let w: World;
afterEach(async () => w?.close());

const h = (s: string): Hex => keccak256(stringToBytes(s));

async function expectCheck(check: ProofCheck, behavior: (w: World) => Behavior, before?: (w: World) => void) {
  w = await makeWorld();
  before?.(w);
  w.gw.behavior = { paid: 'deliver', ...behavior(w) };
  const r = await w.client.payAndVerify(w.url, { body: w.body });
  expect({ outcome: r.outcome, check: r.check }).toEqual({ outcome: 'paid_but_rejected', check });
  expect(r.settlementTx).toMatch(/^0x[0-9a-f]{64}$/);
  const ev = readFileSync(join(w.dataDir, 'evidence.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(ev.at(-1)).toMatchObject({ outcome: 'paid_but_rejected', check });
  return r;
}

describe('INV-13: one ProofCheck per failed V10 check', () => {
  it('missing_proof: no X-Attested-Proof on the 200', () => expectCheck('missing_proof', () => ({ noProof: true })));

  it('bad_signature: X-Attested-Proof is not the §2.5 grammar', () =>
    expectCheck('bad_signature', () => ({ rawProofHeader: Buffer.from('{"proof":{}}').toString('base64') })));

  it('bad_signature: header signer ≠ recovered (another key signed, header names the enclave)', () =>
    expectCheck('bad_signature', (w) => ({ signWith: randomAccount(), headerSigner: w.enclave.address })));

  it("signer_not_active: another key's valid signature, honestly named in the header", () =>
    expectCheck('signer_not_active', () => ({ signWith: randomAccount() })));

  it('request_mismatch: proof for another requestId', () =>
    expectCheck('request_mismatch', () => ({ proof: (p) => ({ ...p, requestId: h('other request') }) })));

  it('request_mismatch: proof over other request bytes', () =>
    expectCheck('request_mismatch', () => ({ proof: (p) => ({ ...p, requestHash: h('other bytes') }) })));

  it('response_hash_mismatch: response altered after signing', () =>
    expectCheck('response_hash_mismatch', () => ({
      tamperResponse: (b) => new TextEncoder().encode(new TextDecoder().decode(b).replace('"allow"', '"deny"')),
    })));

  it('payment_mismatch: paymentId is not the authorization nonce', () =>
    expectCheck('payment_mismatch', () => ({ proof: (p) => ({ ...p, paymentId: h('other nonce') }) })));

  it('inputs_hash_mismatch: inputsHash does not cover the response inputs', () =>
    expectCheck('inputs_hash_mismatch', () => ({ proof: (p) => ({ ...p, inputsHash: h('other inputs') }) })));

  it('inputs_mismatch: fabricated balance (operator fed the enclave false inputs)', () =>
    expectCheck('inputs_mismatch', () => ({
      inputs: (i) => ({ ...i, payTo: { ...(i.payTo as object), balanceWei: '999' } }),
    })));

  it('inputs_mismatch: fabricated nonce', () =>
    expectCheck('inputs_mismatch', () => ({ inputs: (i) => ({ ...i, payTo: { ...(i.payTo as object), nonce: '0' } }) })));

  it('inputs_mismatch: fabricated block hash', () =>
    expectCheck('inputs_mismatch', () => ({ inputs: (i) => ({ ...i, block: { ...(i.block as object), hash: h('fake block') } }) })));

  it('stale_inputs: inputs block more than 300 s before signing', () =>
    expectCheck(
      'stale_inputs',
      (w) => ({
        inputs: (i) => {
          const old = w.chain.blocks.at(-320)!;
          return { ...i, block: { number: old.number.toString(), hash: old.hash, timestamp: old.timestamp.toString() } };
        },
      }),
      (w) => w.chain.advance(400),
    ));

  it('clock_skew: issuedAt more than 120 s before signing', () =>
    expectCheck('clock_skew', () => ({ proof: (p) => ({ ...p, issuedAt: p.issuedAt - 121n, expiresAt: p.issuedAt - 121n + 600n }) })));

  it('clock_skew: issuedAt more than 120 s after the settlement block', () =>
    expectCheck('clock_skew', () => ({ proof: (p) => ({ ...p, issuedAt: p.issuedAt + 125n, expiresAt: p.issuedAt + 125n + 600n }) })));

  it('proof_expired: expiresAt ≠ issuedAt + 600', () =>
    expectCheck('proof_expired', () => ({ proof: (p) => ({ ...p, expiresAt: p.issuedAt + 601n }) })));

  it('signer_not_active: signer revoked before the settlement block', () =>
    expectCheck('signer_not_active', (w) => ({
      proof: (p) => {
        w.chain.revokeSigner(w.enclave.address);
        return p;
      },
    })));

  it('release_not_approved: release deprecated before the settlement block', () =>
    expectCheck('release_not_approved', (w) => ({
      proof: (p) => {
        w.chain.setReleaseStatus(7n, w.releaseId, 2);
        return p;
      },
    })));

  it("release_not_approved: proof names a release other than the signer's", () =>
    expectCheck('release_not_approved', () => ({ proof: (p) => ({ ...p, releaseId: h('other release') }) })));

  it('endpoint_mismatch: endpoint retired before the settlement block', () =>
    expectCheck('endpoint_mismatch', (w) => ({
      proof: (p) => {
        w.chain.retireEndpoint(w.gw.originHash);
        return p;
      },
    })));

  it('agent_mismatch: proof for another agent', () => expectCheck('agent_mismatch', () => ({ proof: (p) => ({ ...p, agentId: 8n }) })));

  it('operator_mismatch: endpoint re-added with a new operator before settlement', () =>
    expectCheck('operator_mismatch', (w) => ({
      proof: (p) => {
        w.chain.retireEndpoint(w.gw.originHash);
        w.chain.addEndpoint(7n, w.origin, w.gw.originHash, w.payTo, randomAccount().address.toLowerCase() as Address);
        return p;
      },
    })));
});

describe('INV-13: V11 must find both logs', () => {
  it('a 200 whose PAYMENT-RESPONSE tx is not on chain is not verified', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'deliver_no_settle' };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r.outcome).toBe('uncertain');
  });

  it('a 200 whose tx moved the money elsewhere (Transfer to another address) is not verified', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'deliver_no_settle' };
    const r0 = await w.client.payAndVerify(w.url, { body: w.body });
    expect(r0.outcome).toBe('uncertain');
    const p = w.gw.paid[0]!;
    w.chain.settle(p.ctx.payer, w.payTo, 20000n, p.ctx.nonce, { transferTo: randomAccount().address });
    const r = await w.client.reconcilePending();
    expect(r[0]!.outcome).toBe('uncertain');
  });
});

describe('INV-13: paid results are judged at their time anchors', () => {
  async function lateFetch(seconds: number, stateDepth = Number.POSITIVE_INFINITY) {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'drop_after_settle', noResults: true };
    const first = await w.client.payAndVerify(w.url, { body: w.body });
    expect(first.outcome).toBe('uncertain');
    w.chain.advance(seconds);
    w.chain.stateDepth = stateDepth;
    w.gw.behavior = {};
    return w.client.getResult(first.requestId);
  }

  it('fetched 200 s after settlement → verified', async () => {
    const r = await lateFetch(200);
    expect(r.outcome).toBe('verified');
    expect(r.inputsChecked).toBe(true);
  });

  it('fetched 2 h after settlement → verified', async () => {
    const r = await lateFetch(7200);
    expect(r.outcome).toBe('verified');
  });

  it('2 h late on an RPC that keeps only 1,000 blocks of state: signer status rebuilt from events, inputs not re-checked', async () => {
    const r = await lateFetch(7200, 1000);
    expect(r.outcome).toBe('verified');
    expect(r.inputsChecked).toBe(false);
    expect(w.chain.calls).toContain('eth_getLogs');
  });

  it('a signer revoked after settlement still verifies (judged at the settlement block)', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'drop_after_settle', noResults: true };
    const first = await w.client.payAndVerify(w.url, { body: w.body });
    w.chain.revokeSigner(w.enclave.address);
    w.chain.advance(200);
    w.gw.behavior = {};
    expect((await w.client.getResult(first.requestId)).outcome).toBe('verified');
  });

  it('event rebuild also catches a revocation before settlement', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = {
      paid: 'drop_after_settle',
      noResults: true,
      proof: (p) => {
        w.chain.revokeSigner(w.enclave.address);
        return p;
      },
    };
    const first = await w.client.payAndVerify(w.url, { body: w.body });
    w.chain.advance(7200);
    w.chain.stateDepth = 1000;
    w.gw.behavior = {};
    const r = await w.client.getResult(first.requestId);
    expect({ outcome: r.outcome, check: r.check }).toEqual({ outcome: 'paid_but_rejected', check: 'signer_not_active' });
  });

  it('an RPC error is never a ProofCheck: no state and no logs → uncertain{rpc_unavailable}', async () => {
    w = await makeWorld({ waitForExpiry: false });
    w.gw.behavior = { paid: 'drop_after_settle', noResults: true };
    const first = await w.client.payAndVerify(w.url, { body: w.body });
    w.chain.advance(7200);
    w.chain.stateDepth = 1000;
    w.gw.behavior = {};
    const realLogs = w.chain.request.bind(w.chain);
    let n = 0;
    w.chain.request = async (method, params) => {
      // Let the settlement lookup through, then fail the registry event scan.
      if (method === 'eth_getLogs' && (params?.[0] as { address?: string }).address === w.chain.registry) n++;
      if (method === 'eth_getLogs' && n > 0) throw new Error('logs pruned');
      return realLogs(method, params);
    };
    const r = await w.client.getResult(first.requestId);
    expect(r).toMatchObject({ outcome: 'uncertain', code: 'rpc_unavailable' });
    expect(r.check).toBeUndefined();
  });

  it('header signer must be the recovered key even when both are registered', async () => {
    w = await makeWorld();
    const second = privateKeyToAccount(generatePrivateKey());
    w.chain.registerSigner(second.address, 7n, w.releaseId, w.gw.originHash, w.operator);
    w.gw.behavior = { signWith: second, headerSigner: w.enclave.address };
    const r = await w.client.payAndVerify(w.url, { body: w.body });
    expect({ outcome: r.outcome, check: r.check }).toEqual({ outcome: 'paid_but_rejected', check: 'bad_signature' });
  });
});
