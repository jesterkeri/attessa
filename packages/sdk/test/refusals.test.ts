import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { livenessDigest, eip712Domain, livenessToJson } from '@attessa/core';
import { createAttestClient } from '../src/client.ts';
import { FakeChain } from './fakes/chain.ts';
import { makeWorld, randomAccount, type World } from './fakes/world.ts';

// INV-12: no EIP-3009 authorization is signed when payTo ≠ registry payTo, asset/domain ≠ the §2.6
// pin, amount > limit, (settled + reserved) + amount > dailyCap, or liveness failed. Every case
// asserts the signing spy saw zero TransferWithAuthorization calls and no reservation is left.

let w: World;
afterEach(async () => w?.close());

function ledgerEntries(dir: string) {
  const p = join(dir, 'pending.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function expectStopped(world: World, code: string, req: Parameters<World['client']['payAndVerify']>[1] = { body: world.body }) {
  const r = await world.client.payAndVerify(world.url, req);
  expect(r.outcome).toBe('stopped');
  expect(r.code).toBe(code);
  expect(world.transferSignatures()).toBe(0);
  expect(world.gw.paid).toHaveLength(0);
  expect(ledgerEntries(world.dataDir).filter((e) => e.state === 'reserved')).toHaveLength(0);
  return r;
}

const entry0 = (pr: Record<string, unknown>) => (pr.accepts as Record<string, unknown>[])[0]!;
const extra0 = (pr: Record<string, unknown>) => entry0(pr).extra as Record<string, unknown>;

describe('INV-12: refusal paths sign nothing', () => {
  it('V4 payTo differs from the registry payTo → payto_mismatch', async () => {
    w = await makeWorld();
    w.gw.behavior = { quote: (pr) => void (entry0(pr).payTo = randomAccount().address.toLowerCase()) };
    await expectStopped(w, 'payto_mismatch');
  });

  it('V3 asset not pinned (only an unknown token offered) → quote_malformed', async () => {
    w = await makeWorld();
    w.gw.behavior = { quote: (pr) => void (entry0(pr).asset = '0x1111111111111111111111111111111111111111') };
    await expectStopped(w, 'quote_malformed');
  });

  it('V3 pinned asset with a different EIP-712 domain name → quote_malformed', async () => {
    w = await makeWorld();
    w.gw.behavior = { quote: (pr) => void (extra0(pr).name = 'USD Coin') };
    await expectStopped(w, 'quote_malformed');
  });

  it('V3 pinned asset with a different domain version → quote_malformed', async () => {
    w = await makeWorld();
    w.gw.behavior = { quote: (pr) => void (extra0(pr).version = '1') };
    await expectStopped(w, 'quote_malformed');
  });

  it('V3 network is not the pinned CAIP-2 id → network_mismatch', async () => {
    w = await makeWorld();
    w.gw.behavior = { quote: (pr) => void (entry0(pr).network = 'eip155:42220') };
    await expectStopped(w, 'network_mismatch');
  });

  it('V3 legacy v1 network name → network_mismatch', async () => {
    w = await makeWorld();
    w.gw.behavior = { quote: (pr) => void (entry0(pr).network = 'celo-sepolia') };
    await expectStopped(w, 'network_mismatch');
  });

  it('V3 x402Version 1 → quote_malformed', async () => {
    w = await makeWorld();
    w.gw.behavior = { quote: (pr) => void (pr.x402Version = 1) };
    await expectStopped(w, 'quote_malformed');
  });

  it('V3 attestedExec names another agent → quote_malformed', async () => {
    w = await makeWorld();
    w.gw.behavior = { quote: (pr) => void ((extra0(pr).attestedExec as Record<string, unknown>).agentId = '8') };
    await expectStopped(w, 'quote_malformed');
  });

  it('V3 non-eip3009 transfer method → quote_malformed', async () => {
    w = await makeWorld();
    w.gw.behavior = { quote: (pr) => void (extra0(pr).assetTransferMethod = 'permit2') };
    await expectStopped(w, 'quote_malformed');
  });

  it('V5 amount above maxAmountPerCall → over_max_amount', async () => {
    w = await makeWorld({ limits: { maxAmountPerCall: 19_999n } });
    await expectStopped(w, 'over_max_amount');
  });

  it('V5 amount above the per-call maxAmount argument → over_max_amount', async () => {
    w = await makeWorld();
    await expectStopped(w, 'over_max_amount', { body: w.body, maxAmount: 10_000n });
  });

  it('V5 maxAmount can only lower the configured limit', async () => {
    w = await makeWorld({ limits: { maxAmountPerCall: 10_000n } });
    await expectStopped(w, 'over_max_amount', { body: w.body, maxAmount: 1_000_000n });
  });

  it('V6 (settled + reserved) + amount > dailyCap → over_daily_cap', async () => {
    w = await makeWorld({ limits: { dailyCap: 30_000n } });
    const first = await w.client.payAndVerify(w.url, { body: w.body });
    expect(first.outcome).toBe('verified');
    w.signSpy.mockClear();
    w.gw.paid.length = 0;
    await expectStopped(w, 'over_daily_cap', { body: w.body, newRequest: true });
  });

  describe('V7 liveness failed → liveness_failed, reservation released', () => {
    it('no liveness object in the quote', async () => {
      w = await makeWorld();
      w.gw.behavior = { liveness: () => null };
      const r = await expectStopped(w, 'liveness_failed');
      expect(r.detail).toBe('missing');
    });

    it('a stale challenge (replayed liveness)', async () => {
      w = await makeWorld();
      const replay = await w.gw.livenessObject(`0x${'01'.repeat(32)}`);
      w.gw.behavior = { liveness: () => replay };
      const r = await expectStopped(w, 'liveness_failed');
      expect(r.detail).toBe('challenge_mismatch');
    });

    it('signed by a key that is not a registered signer', async () => {
      w = await makeWorld();
      const other = privateKeyToAccount(generatePrivateKey());
      w.gw.livenessObject = async (challenge) => {
        const lv = { agentId: 7n, releaseId: w.releaseId, originHash: w.gw.originHash, challenge, issuedAt: w.chain.head.timestamp };
        const domain = eip712Domain(BigInt(w.chain.chainId), w.chain.registry);
        return { liveness: livenessToJson(lv), signature: await other.sign!({ hash: livenessDigest(domain, lv) }) };
      };
      const r = await expectStopped(w, 'liveness_failed');
      expect(r.detail).toBe('unknown_signer');
    });

    it('the signer was revoked', async () => {
      w = await makeWorld();
      w.chain.revokeSigner(w.enclave.address);
      const r = await expectStopped(w, 'liveness_failed');
      expect(r.detail).toBe('signer_revoked');
    });

    it('the release was revoked', async () => {
      w = await makeWorld();
      w.chain.setReleaseStatus(7n, w.releaseId, 3);
      const r = await expectStopped(w, 'liveness_failed');
      expect(r.detail).toBe('release_not_approved');
    });

    it('issuedAt more than 120 s from chain time', async () => {
      w = await makeWorld();
      const honest = w.gw.livenessObject.bind(w.gw);
      w.gw.livenessObject = async (challenge) => {
        const o = await honest(challenge);
        w.chain.advance(121);
        return o;
      };
      const r = await expectStopped(w, 'liveness_failed');
      expect(r.detail).toBe('clock_skew');
    });

    it('issuedAt exactly 120 s behind chain time still passes', async () => {
      w = await makeWorld();
      const honest = w.gw.livenessObject.bind(w.gw);
      w.gw.livenessObject = async (challenge) => {
        const o = await honest(challenge);
        w.chain.advance(120);
        return o;
      };
      const r = await w.client.payAndVerify(w.url, { body: w.body });
      expect(r.outcome).toBe('verified');
    });

    it('the liveness signature is malformed', async () => {
      w = await makeWorld();
      w.gw.behavior = { liveness: (h) => ({ ...h, signature: `0x${'00'.repeat(65)}` }) };
      const r = await expectStopped(w, 'liveness_failed');
      expect(r.detail).toBe('bad_signature');
    });
  });

  describe('V1/V2 stop before any quote is accepted', () => {
    it('origin not registered → endpoint_not_registered', async () => {
      w = await makeWorld();
      const other = new URL(w.url);
      other.port = String(Number(other.port) + 1);
      const r = await w.client.payAndVerify(other.toString(), { body: w.body });
      expect(r).toMatchObject({ outcome: 'stopped', code: 'endpoint_not_registered' });
      expect(w.transferSignatures()).toBe(0);
    });

    it('endpoint retired → endpoint_retired', async () => {
      w = await makeWorld();
      w.chain.retireEndpoint(w.gw.originHash);
      await expectStopped(w, 'endpoint_retired');
    });

    it('.well-known names another agent → origin_agent_mismatch', async () => {
      w = await makeWorld();
      (w.gw as unknown as { agentId: bigint }).agentId = 8n;
      await expectStopped(w, 'origin_agent_mismatch');
    });

    it('RPC down → rpc_unavailable', async () => {
      w = await makeWorld();
      w.chain.failing.add('eth_call');
      await expectStopped(w, 'rpc_unavailable');
    });

    it('RPC answers no chain id → rpc_unavailable', async () => {
      w = await makeWorld();
      w.chain.failing.add('eth_chainId');
      await expectStopped(w, 'rpc_unavailable');
    });

    it('RPC on another chain than the configured network → network_mismatch', async () => {
      w = await makeWorld();
      const mainnetRpc = new FakeChain({ chainId: 42220 });
      const c = createAttestClient(
        { network: 'celo-sepolia', account: w.account, limits: { usdc: { maxAmountPerCall: 1n, dailyCap: 1n }, usat: { maxAmountPerCall: 1n, dailyCap: 1n } }, asset: 'usdc', dataDir: w.dataDir },
        { registry: w.chain.registry, transport: mainnetRpc.transport() },
      );
      const r = await c.payAndVerify('https://risk.example/v1/evaluate', { body: w.body });
      expect(r).toMatchObject({ outcome: 'stopped', code: 'network_mismatch' });
      expect(w.transferSignatures()).toBe(0);
    });

    it('gateway paused → gateway_paused', async () => {
      w = await makeWorld();
      w.gw.behavior = {
        unpaid: (res, id) => {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'gateway_paused', detail: null, message: 'paused', suggestion: 'retry_later', correlationId: 'c', requestId: id }));
          return true;
        },
      };
      await expectStopped(w, 'gateway_paused');
    });

    it('not a 402 → quote_unavailable', async () => {
      w = await makeWorld();
      w.gw.behavior = { unpaid: (res) => (res.end('ok'), true) };
      await expectStopped(w, 'quote_unavailable');
    });

    it('402 without a decodable PAYMENT-REQUIRED → quote_malformed', async () => {
      w = await makeWorld();
      w.gw.behavior = {
        unpaid: (res) => {
          res.statusCode = 402;
          res.setHeader('PAYMENT-REQUIRED', 'not base64!');
          res.end('{}');
          return true;
        },
      };
      await expectStopped(w, 'quote_malformed');
    });
  });
});
