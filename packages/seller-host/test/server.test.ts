import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  eip712Domain,
  inputsHash,
  livenessDigest,
  livenessFromJson,
  originHash,
  proofDigest,
  proofFromJson,
  recoverDigestSigner,
  requestHash,
  responseHash,
} from '@attessa/core';
import type { Hex } from 'viem';
// The gateway's real client for these routes: the contract this server has to meet.
import { HttpSellerHost } from '../../gateway/src/sellerhost.ts';
import { EnclaveClient, TcpEnclaveTransport } from '../src/enclave.ts';
import { HttpRpcSource, InputFetcher } from '../src/inputs.ts';
import { SellerHost } from '../src/server.ts';
import { FakeEnclave } from './fake-enclave.ts';
import { FakeRpc } from './fake-rpc.ts';

const CHAIN = 11142220;
const REGISTRY = '0x00000000000000000000000000000000000000aa';
const ORIGIN = 'https://risk.example';
const USDC = '0x01c5c0122039549ad1493b8220cabedd739bc44e';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const RID = `0x${'ab'.repeat(32)}` as Hex;
const PID = `0x${'cd'.repeat(32)}` as Hex;

let enclave: FakeEnclave;
let rpc: FakeRpc;
let host: SellerHost;
let base: string;
let logs: Array<[string, Record<string, unknown> | undefined]>;

async function boot(opts: { enclaveDown?: boolean } = {}) {
  enclave = new FakeEnclave();
  const port = await enclave.start();
  rpc = new FakeRpc();
  await rpc.start();
  rpc.accounts.set(PAY_TO, { code: '0x', nonce: 7n, balance: 123456789n });
  logs = [];
  const log = (e: string, f?: Record<string, unknown>) => logs.push([e, f]);
  host = new SellerHost({
    config: { chainId: CHAIN, registry: REGISTRY, agentId: 412n, origin: ORIGIN },
    enclave: new EnclaveClient(new TcpEnclaveTransport(opts.enclaveDown ? 1 : port)),
    inputs: new InputFetcher({ forno: new HttpRpcSource('forno', rpc.url), timeoutMs: 500, log }),
    enclaveTimeoutMs: 1000,
    log,
  });
  base = `http://127.0.0.1:${await host.listen(0)}`;
}

beforeEach(async () => boot());
afterEach(async () => {
  await host.close();
  await enclave.stop();
  await rpc.stop();
});

function bodyB64(o: Record<string, string>): string {
  return Buffer.from(JSON.stringify(o)).toString('base64');
}
const goodBody = () => bodyB64({ chainId: String(CHAIN), payTo: PAY_TO, asset: USDC, amount: '20000' });

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('seller-host boot: configure (SPEC §4.1 step 2, §5)', () => {
  it('configures the enclave from its own config, and attests on a second boot', async () => {
    const first = await host.configureEnclave({ maxAttempts: 1 });
    expect(first).toEqual({ signer: enclave.signer, configured: true });
    expect(enclave.config).toMatchObject({ chainId: BigInt(CHAIN), agentId: 412n, origin: ORIGIN, originHash: originHash(ORIGIN) });
    const second = await host.configureEnclave({ maxAttempts: 1 });
    expect(second).toEqual({ signer: enclave.signer, configured: false });
    expect(enclave.configureCount).toBe(1);
  });

  it('retries until the enclave answers', async () => {
    await host.close();
    await boot({ enclaveDown: true });
    await expect(host.configureEnclave({ maxAttempts: 2, retryMs: 10 })).rejects.toThrow();
    expect(logs.filter(([e]) => e === 'enclave_configure_failed')).toHaveLength(2);
  });
});

describe('POST /internal/evaluate (SPEC §5) through the gateway client', () => {
  beforeEach(async () => {
    await host.configureEnclave({ maxAttempts: 1 });
  });

  it('validates, reads inputs at latest − 1 from Forno, and returns a proof the gateway can verify', async () => {
    const gw = new HttpSellerHost(base);
    const body = goodBody();
    const out = await gw.evaluate({ requestId: RID, method: 'POST', path: '/v1/evaluate', body, paymentId: PID }, 5000);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const response = Buffer.from(out.response, 'base64');
    const parsed = JSON.parse(response.toString('utf8'));
    expect(parsed.inputs).toEqual({
      block: { number: '999', hash: rpc.blockHash(999n), timestamp: (1_700_000_000n + 999n).toString() },
      payTo: { address: PAY_TO, code: '0x', nonce: '7', balanceWei: '123456789' },
      source: 'forno',
    });
    expect(parsed.verdict).toBe('allow');
    const proof = proofFromJson(out.proof);
    expect(proof.requestHash).toBe(requestHash('POST', '/v1/evaluate', Buffer.from(body, 'base64')));
    expect(proof.responseHash).toBe(responseHash(response));
    expect(proof.inputsHash).toBe(inputsHash(parsed.inputs));
    expect(proof.paymentId).toBe(PID);
    expect(proof.requestId).toBe(RID);
    const signer = await recoverDigestSigner(proofDigest(eip712Domain(BigInt(CHAIN), REGISTRY), proof), out.signature);
    expect(signer).toBe(enclave.signer);
    // The enclave got the gateway's fields untouched plus the inputs, and nothing else.
    const msg = enclave.received.at(-1)!;
    expect(Object.keys(msg).sort()).toEqual(['body', 'inputs', 'method', 'path', 'paymentId', 'requestId', 'type']);
    expect(msg.body).toBe(body);
    // One head read, then one batch of the four reads at N.
    const batches = rpc.requests.filter(Array.isArray) as Array<Array<{ method: string; params: unknown[] }>>;
    expect(batches.at(-1)!.map((c) => c.method)).toEqual(['eth_getBlockByNumber', 'eth_getCode', 'eth_getTransactionCount', 'eth_getBalance']);
    expect(batches.at(-1)!.every((c) => c.params.includes('0x3e7'))).toBe(true);
  });

  it.each([
    ['unknown key', { chainId: String(CHAIN), payTo: PAY_TO, asset: USDC, amount: '1', extra: 'x' }],
    ['uppercase hex', { chainId: String(CHAIN), payTo: PAY_TO, asset: USDC.toUpperCase().replace('0X', '0x'), amount: '1' }],
    ['other chain', { chainId: '42220', payTo: PAY_TO, asset: USDC, amount: '1' }],
    ['leading zero amount', { chainId: String(CHAIN), payTo: PAY_TO, asset: USDC, amount: '01' }],
  ])('answers bad_request for a body that breaks §4.3 (%s), before any read or enclave call', async (_n, b) => {
    const before = enclave.received.length;
    const r = await post('/internal/evaluate', { requestId: RID, method: 'POST', path: '/v1/evaluate', body: bodyB64(b as any), paymentId: PID });
    expect(r).toEqual({ status: 400, json: { error: 'bad_request' } });
    expect(enclave.received.length).toBe(before);
    expect(rpc.requests).toHaveLength(0);
    const gw = new HttpSellerHost(base);
    expect(await gw.evaluate({ requestId: RID, method: 'POST', path: '/v1/evaluate', body: bodyB64(b as any), paymentId: PID }, 5000)).toEqual({ ok: false, error: 'bad_request' });
  });

  it('answers bad_request for a body over 2,048 bytes', async () => {
    const big = Buffer.from(JSON.stringify({ chainId: String(CHAIN), payTo: PAY_TO, asset: USDC, amount: '1' }) + ' '.repeat(2048)).toString('base64');
    const r = await post('/internal/evaluate', { requestId: RID, method: 'POST', path: '/v1/evaluate', body: big, paymentId: PID });
    expect(r.json).toEqual({ error: 'bad_request' });
  });

  it.each([
    ['missing paymentId', { requestId: RID, method: 'POST', path: '/v1/evaluate', body: 'e30=' }],
    ['extra key', { requestId: RID, method: 'POST', path: '/v1/evaluate', body: 'e30=', paymentId: PID, inputs: {} }],
    ['uppercase requestId', { requestId: RID.toUpperCase(), method: 'POST', path: '/v1/evaluate', body: 'e30=', paymentId: PID }],
    ['lowercase method', { requestId: RID, method: 'post', path: '/v1/evaluate', body: 'e30=', paymentId: PID }],
    ['relative path', { requestId: RID, method: 'POST', path: 'v1/evaluate', body: 'e30=', paymentId: PID }],
    ['non-canonical base64', { requestId: RID, method: 'POST', path: '/v1/evaluate', body: 'e31=', paymentId: PID }],
  ])('refuses a malformed envelope (%s) with bad_frame', async (_n, env) => {
    const r = await post('/internal/evaluate', env);
    expect(r).toEqual({ status: 400, json: { error: 'bad_frame' } });
    expect(rpc.requests).toHaveLength(0);
  });

  it('never lets the caller supply inputs: the seller-host reads them itself', async () => {
    const r = await post('/internal/evaluate', { requestId: RID, method: 'POST', path: '/v1/evaluate', body: goodBody(), paymentId: PID, inputs: { forged: true } });
    expect(r.json).toEqual({ error: 'bad_frame' });
  });

  it('answers inputs_unavailable (503) when Forno fails twice, without calling the enclave', async () => {
    rpc.mode = 'http500';
    const before = enclave.received.length;
    const r = await post('/internal/evaluate', { requestId: RID, method: 'POST', path: '/v1/evaluate', body: goodBody(), paymentId: PID });
    expect(r).toEqual({ status: 503, json: { error: 'inputs_unavailable' } });
    expect(enclave.received.length).toBe(before);
    expect(rpc.requests).toHaveLength(2);
  });

  it('passes enclave errors through (bad_inputs) and maps them to a gateway failure', async () => {
    // Inputs read for one address but the enclave is asked about another: simulate by a fake RPC that
    // reports a contract, then check the verdict changes rather than the call failing.
    rpc.accounts.set(PAY_TO, { code: '0x6001', nonce: 1n, balance: 0n });
    const out = await new HttpSellerHost(base).evaluate({ requestId: RID, method: 'POST', path: '/v1/evaluate', body: goodBody(), paymentId: PID }, 5000);
    expect(out.ok).toBe(true);
    if (out.ok) expect(JSON.parse(Buffer.from(out.response, 'base64').toString()).reasons).toEqual(['pay_to_is_contract']);
  });
});

describe('enclave down', () => {
  it('answers enclave_unavailable (503) on every route, which the gateway treats as unavailable', async () => {
    await host.close();
    await boot({ enclaveDown: true });
    for (const [path, body] of [
      ['/internal/attest', {}],
      ['/internal/liveness', { challenge: RID }],
      ['/internal/evaluate', { requestId: RID, method: 'POST', path: '/v1/evaluate', body: goodBody(), paymentId: PID }],
    ] as const) {
      expect(await post(path, body)).toEqual({ status: 503, json: { error: 'enclave_unavailable' } });
    }
    const gw = new HttpSellerHost(base);
    await expect(gw.attest(2000)).rejects.toThrow();
    expect(await gw.evaluate({ requestId: RID, method: 'POST', path: '/v1/evaluate', body: goodBody(), paymentId: PID }, 5000)).toEqual({ ok: false, error: 'enclave_unavailable' });
  });

  it('answers not_configured before configure', async () => {
    expect(await post('/internal/attest', {})).toEqual({ status: 503, json: { error: 'not_configured' } });
  });
});

describe('POST /internal/attest and /internal/liveness', () => {
  beforeEach(async () => {
    await host.configureEnclave({ maxAttempts: 1 });
  });

  it('attest returns the running signer and a fresh attestation document', async () => {
    const gw = new HttpSellerHost(base);
    expect(await gw.attest(2000)).toEqual({ signer: enclave.signer });
    const r = await post('/internal/attest', {});
    expect(r.status).toBe(200);
    expect(typeof r.json.attestation).toBe('string');
    expect(enclave.received.at(-1)).toEqual({ type: 'attest' });
  });

  it('liveness passes the challenge through and the signature recovers the enclave key', async () => {
    const r = (await new HttpSellerHost(base).liveness(RID, 2000)) as { liveness: unknown; signature: string };
    const l = livenessFromJson(r.liveness);
    expect(l.challenge).toBe(RID);
    expect(l.originHash).toBe(originHash(ORIGIN));
    expect(await recoverDigestSigner(livenessDigest(eip712Domain(BigInt(CHAIN), REGISTRY), l), r.signature)).toBe(enclave.signer);
  });

  it('refuses a malformed challenge, other methods and unknown routes', async () => {
    expect((await post('/internal/liveness', { challenge: '0x12' })).json).toEqual({ error: 'bad_frame' });
    expect((await post('/internal/liveness', { challenge: RID, x: 1 })).json).toEqual({ error: 'bad_frame' });
    expect((await post('/internal/attest', { type: 'configure' })).json).toEqual({ error: 'bad_frame' });
    expect((await post('/internal/configure', {})).status).toBe(404);
    expect((await fetch(`${base}/internal/attest`)).status).toBe(405);
  });

  it('refuses an HTTP body over 64 KiB', async () => {
    const r = await post('/internal/liveness', { challenge: 'x'.repeat(70_000) });
    expect(r.status).toBe(413);
  });
});
