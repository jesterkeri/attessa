import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { keccak256, stringToBytes, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeChain } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import { createMcpServer, scrub } from '../src/index.ts';

// The MCP server through a real MCP client over an in-memory transport, against the SDK's fake chain and x402 gateway.
// No network, no real keys: every key is generated in-test.

const AGENT = 412n;
const SOURCE = 'https://github.com/acme/risk/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const VECTORS = JSON.parse(readFileSync(new URL('../../../vectors/headers.json', import.meta.url), 'utf8')) as {
  attestedProof: { valid: Array<{ name: string; header: string; chainId: string; verifyingContract: string }> };
};
const SEPOLIA_VECTOR = VECTORS.attestedProof.valid.find((v) => v.name === 'sepolia')!;

async function world(config: unknown = { network: 'local', limits: { usdc: { maxAmountPerCall: '0.10', dailyCap: '1.00' } } }) {
  const chain = new FakeChain({ startTime: 1_793_000_000n, startBlock: 31_204_000n });
  const rnd = () => privateKeyToAccount(generatePrivateKey());
  const operator = rnd().address.toLowerCase() as Address;
  const payTo = rnd().address.toLowerCase() as Address;
  const enclave = rnd();
  const releaseId = keccak256(stringToBytes(`release-${Math.random()}`));
  chain.approveRelease(AGENT, releaseId, SOURCE);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, releaseId, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);

  const home = mkdtempSync(join(tmpdir(), 'attessa-mcp-'));
  const dataDir = join(home, '.attessa');
  const key = generatePrivateKey();
  const w = {
    chain,
    gw,
    origin,
    url: `${origin}/v1/evaluate`,
    home,
    dataDir,
    key,
    env: { ATTESSA_REGISTRY: chain.registry, ATTESSA_PRIVATE_KEY: key, ATTESSA_NETWORK: 'local', ATTESSA_RPC: 'http://127.0.0.1:1', ATTESSA_DATA_DIR: dataDir } as Record<string, string | undefined>,
    body: { chainId: String(chain.chainId), payTo, asset: chain.asset, amount: '20000' },
    client: undefined as unknown as Client,
    async connect() {
      const server = createMcpServer({
        deps: {
          env: w.env,
          cwd: home,
          home,
          keychain: null,
          rpc: () => {
            throw new Error('buyer commands use the SDK transport');
          },
          runner: { run: async () => ({ code: 1, stdout: '', stderr: 'no runner' }) },
          fetch,
          enclave: () => {
            throw new Error('no enclave');
          },
          readFile: (p) => readFileSync(p),
          writeFile: (p, d) => writeFileSync(p, d),
          exists: (p) => existsSync(p),
          readdir: (p) => readdirSync(p),
          sleep: async () => {},
          arch: 'x64',
          sdk: { transport: chain.transport(), sleep: async (ms: number) => chain.advance(Math.max(1, ms / 1000)), receiptWaitMs: 2000, httpTimeoutMs: 5000 },
        },
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      w.client = new Client({ name: 'test', version: '0' });
      await w.client.connect(b);
    },
    async tool(name: string, args: Record<string, unknown> = {}) {
      const r = await w.client.callTool({ name, arguments: args });
      const text = (r.content as Array<{ text: string }>)[0]!.text;
      return { isError: r.isError === true, text, json: JSON.parse(text) as Record<string, any> };
    },
    pending() {
      const p = join(dataDir, 'pending.jsonl');
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    async close() {
      await w.client?.close();
      await gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dataDir, { recursive: true });
  if (config !== null) writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
  await w.connect();
  return w;
}

type W = Awaited<ReturnType<typeof world>>;
let w: W;
afterEach(async () => w?.close());

describe('mcp: the tool list', () => {
  it('lists exactly the 9 FLOWS agent tools, each with a JSON schema and a description', async () => {
    w = await world();
    const { tools } = await w.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['cancel_authorization', 'check_liveness', 'get_result', 'list_pending', 'pay_and_verify', 'quote', 'resolve_endpoint', 'status', 'verify_proof'],
    );
    expect(tools).toHaveLength(9);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description!.length).toBeGreaterThan(30);
    }
    const d = (n: string) => tools.find((t) => t.name === n)!.description!;
    expect(d('pay_and_verify')).toMatch(/SIDE EFFECT/);
    expect(d('pay_and_verify')).toMatch(/signs/i);
    expect(d('cancel_authorization')).toMatch(/SIDE EFFECT/);
    expect(d('cancel_authorization')).toMatch(/transaction/i);
    for (const n of ['resolve_endpoint', 'check_liveness', 'verify_proof', 'list_pending']) expect(d(n)).not.toMatch(/SIDE EFFECT/);
  });
});

describe('mcp: verify_proof on a recorded vector (vectors/headers.json)', () => {
  it('accepts the recorded Sepolia proof and says what it did not check', async () => {
    w = await world(null);
    const r = await w.tool('verify_proof', { proof: SEPOLIA_VECTOR.header, chainId: Number(SEPOLIA_VECTOR.chainId), registry: SEPOLIA_VECTOR.verifyingContract });
    expect(r.isError).toBe(false);
    expect(r.json.ok).toBe(true);
    expect(r.json.signer).toBe('0xc5075acfa6dcc50ec3aba08c8fea26c14e9ddefb');
    expect(r.json.passed).toEqual(['signature', 'lifetime']);
    expect(r.json.notChecked).toContain('signer_active_on_chain');
    expect(r.json.proof.agentId).toBe('1');
  });

  it('refuses it under another registry, another chain, and a wrong response, with the FLOWS-style code and a next action', async () => {
    w = await world(null);
    const base = { proof: SEPOLIA_VECTOR.header, chainId: Number(SEPOLIA_VECTOR.chainId), registry: SEPOLIA_VECTOR.verifyingContract };
    for (const bad of [{ registry: '0x0000000000000000000000000000000000000001' }, { chainId: 42220 }]) {
      const r = await w.tool('verify_proof', { ...base, ...bad });
      expect(r.isError).toBe(true);
      expect(r.json).toMatchObject({ error: 'proof_rejected', check: 'bad_signature' });
      expect(r.json.message).toMatch(/isn't signed by the sealed machine's key/);
      expect(r.json.next).toMatch(/get_result/);
    }
    const resp = await w.tool('verify_proof', { ...base, response: '{"inputs":{}}' });
    expect(resp.json).toMatchObject({ ok: false, check: 'response_hash_mismatch' });
    const req = await w.tool('verify_proof', { ...base, requestId: `0x${'ab'.repeat(32)}` });
    expect(req.json).toMatchObject({ ok: false, check: 'request_mismatch' });
    const junk = await w.tool('verify_proof', { ...base, proof: 'not base64!' });
    expect(junk.json).toMatchObject({ ok: false, check: 'bad_signature' });
  });

  it('a chain with no pinned registry asks for one', async () => {
    w = await world(null);
    const r = await w.tool('verify_proof', { proof: SEPOLIA_VECTOR.header, chainId: 31337 });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ error: 'no_registry' });
    expect(r.json.next).toBeTruthy();
  });
});

describe('mcp: reads need no wallet', () => {
  it('resolve_endpoint and check_liveness work with no key set', async () => {
    w = await world();
    delete w.env.ATTESSA_PRIVATE_KEY;
    const a = await w.tool('resolve_endpoint', { url: w.url });
    expect(a.isError).toBe(false);
    expect(a.json).toMatchObject({ ok: true, agentId: String(AGENT) });
    expect(a.json.endpoint.status).toBe('active');
    const b = await w.tool('check_liveness', { url: w.url });
    expect(b.json).toMatchObject({ ok: true, liveness: { ok: true } });
  });

  it('an unregistered service is the FLOWS refusal with a next action', async () => {
    w = await world();
    const r = await w.tool('resolve_endpoint', { url: 'https://nobody.example/v1/x' });
    expect(r.isError).toBe(true);
    expect(r.json.error).toBeTruthy();
    expect(r.json.message).toBeTruthy();
    expect(r.json.next).toBeTruthy();
  });

  it('list_pending reads the local ledger only', async () => {
    w = await world();
    delete w.env.ATTESSA_PRIVATE_KEY;
    const r = await w.tool('list_pending');
    expect(r.json).toMatchObject({ ok: true, pending: [] });
    expect(r.json.lines[0]).toMatch(/./);
  });
});

describe('mcp: pay_and_verify and its bounds', () => {
  it('pays within bounds, returns the verified answer, and never shows the key', async () => {
    w = await world();
    const r = await w.tool('pay_and_verify', { url: w.url, body: w.body });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ ok: true, outcome: 'verified' });
    expect(typeof r.json.response).toBe('string');
    expect(JSON.parse(r.json.response)).toBeTruthy();
    expect(r.text).not.toContain(w.key);
    expect(r.text).not.toContain(w.key.slice(2));
    // the answer is kept beside the record, as the CLI keeps it
    expect(existsSync(join(w.dataDir, `${r.json.requestId}.json`))).toBe(true);
    const got = await w.tool('get_result', { requestId: r.json.requestId });
    expect(got.json).toMatchObject({ ok: true, state: 'verified', outcome: 'verified' });
    expect(got.json.response).toBe(r.json.response);
    const status = await w.tool('status');
    expect(status.isError).toBe(false);
    expect(status.text).not.toContain(w.key);
  });

  it('refuses before signing when the price is over maxAmount', async () => {
    w = await world();
    const r = await w.tool('pay_and_verify', { url: w.url, body: w.body, maxAmount: '0.01' });
    expect(r.isError).toBe(true);
    expect(r.json.error ?? r.json.code).toBe('over_max_amount');
    expect(w.pending().filter((e) => e.nonce !== null)).toEqual([]);
  });

  it('an agent can lower the owner-set per-call limit but never raise it', async () => {
    w = await world();
    const r = await w.tool('pay_and_verify', { url: w.url, body: w.body, maxAmount: '5' });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ ok: false, error: 'over_max_amount' });
    expect(r.json.message).toMatch(/Nothing was signed/);
    expect(r.json.next).toMatch(/0\.10/);
    expect(w.pending()).toEqual([]);
  });

  it('with no saved limit, maxAmount is required', async () => {
    w = await world(null);
    const r = await w.tool('pay_and_verify', { url: w.url, body: w.body });
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe('max_amount_required');
    expect(r.json.next).toBeTruthy();
    expect(w.pending()).toEqual([]);
  });

  it('refuses a second call that would pass the daily cap, before signing it', async () => {
    w = await world({ network: 'local', limits: { usdc: { maxAmountPerCall: '0.10', dailyCap: '0.03' } } });
    const first = await w.tool('pay_and_verify', { url: w.url, body: w.body });
    expect(first.json.outcome).toBe('verified');
    const second = await w.tool('pay_and_verify', { url: w.url, body: w.body, newRequest: true });
    expect(second.isError).toBe(true);
    expect(second.json.error ?? second.json.code).toBe('over_daily_cap');
    expect(w.pending().filter((e) => e.state !== 'verified' && e.nonce !== null)).toEqual([]);
  });

  it('a body that is not JSON is refused, and no file is ever read', async () => {
    w = await world();
    writeFileSync(join(w.home, 'tx.json'), JSON.stringify(w.body));
    const r = await w.tool('pay_and_verify', { url: w.url, body: 'tx.json' });
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe('usage');
    expect(w.pending()).toEqual([]);
  });

  it('quote shows the price and signs nothing', async () => {
    w = await world();
    const r = await w.tool('quote', { url: w.url, body: w.body });
    expect(r.isError).toBe(false);
    expect(r.json.lines.join('\n')).toMatch(/0\.02/);
    expect(w.pending()).toEqual([]);
  });

  it('cancel_authorization on an unknown request names the next action', async () => {
    w = await world();
    const r = await w.tool('cancel_authorization', { requestId: `0x${'cd'.repeat(32)}` });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ ok: false, error: 'unknown_request' });
    expect(r.json.next).toBeTruthy();
    const g = await w.tool('get_result', { requestId: `0x${'cd'.repeat(32)}` });
    expect(g.json.error).toBe('unknown_request');
  });
});

describe('mcp: no secret in any output', () => {
  it('a malformed key is not echoed back', async () => {
    w = await world();
    const bad = `0x${'zz'.repeat(32)}-marker`;
    w.env.ATTESSA_PRIVATE_KEY = bad;
    for (const [name, args] of [['status', {}], ['quote', { url: w.url, body: w.body }], ['cancel_authorization', { requestId: `0x${'ab'.repeat(32)}` }]] as const) {
      const r = await w.tool(name, args);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain(bad);
      expect(r.text).not.toContain('marker');
      expect(r.json.error).toBe('bad_key');
      expect(r.json.next).toBeTruthy();
    }
  });

  it('a keystore password, a key and URL credentials are scrubbed from any text', () => {
    const env = { ATTESSA_PRIVATE_KEY: `0x${'ab'.repeat(32)}`, ATTESSA_KEYSTORE_PASSWORD: 'hunter2-hunter2', FACILITATOR_API_KEY: 'fac-secret-123' };
    const out = scrub(`k ${env.ATTESSA_PRIVATE_KEY} ${'ab'.repeat(32)} p hunter2-hunter2 f fac-secret-123 u https://user:pw@rpc.example/v3/x`, env);
    expect(out).not.toMatch(/abab|hunter2|fac-secret|user:pw/);
    expect(out).toContain('https://rpc.example/v3/x');
  });
});

describe('mcp: Codex r1 Major 1, short and encoded secrets never reach a result', () => {
  it('through the result path: a short password, a URL-encoded value and a JSON-escaped value are all hidden', async () => {
    w = await world();
    w.env.ATTESSA_KEYSTORE_PASSWORD = 'abc123';
    w.env.FACILITATOR_API_KEY = 'p@ss w/rd&1';
    w.env.SERVICE_TOKEN = 'x"y\\zzz';
    // An unknown tool's error names the tool, so what the caller types comes back through the real result path.
    for (const leak of ['abc123', 'p@ss w/rd&1', encodeURIComponent('p@ss w/rd&1'), 'x"y\\zzz']) {
      const r = await w.tool(`prefix-${leak}-suffix`);
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain(leak);
      expect(r.text).not.toContain(JSON.stringify(leak).slice(1, -1));
      expect(r.text).toContain('prefix-');
    }
  });

  it('scrub: short secrets, encodings and an empty value (nothing to hide, nothing mangled)', () => {
    const env = { ATTESSA_KEYSTORE_PASSWORD: 'abc123', EMPTY_SECRET: '', FACILITATOR_API_KEY: 'a b&c' };
    const out = scrub(`pw abc123 enc ${encodeURIComponent('a b&c')} plus a+b%26c raw a b&c`, env);
    expect(out).not.toMatch(/abc123|a b&c|a%20b%26c/);
    expect(out.startsWith('pw ')).toBe(true);
  });
});

const VECTOR_REQUEST_HASH = '0xd0e8ee59691076ca21a43abc5a48d77229446eb7025e5c07063fdc9a8419ed00';
const vectorArgs = () => ({ proof: SEPOLIA_VECTOR.header, chainId: Number(SEPOLIA_VECTOR.chainId), registry: SEPOLIA_VECTOR.verifyingContract });

describe('mcp: Codex r1 Major 2, verify_proof checks the request hash when it is given one', () => {
  it('an expected requestHash that matches passes as `request_hash`; one that differs is request_mismatch', async () => {
    w = await world(null);
    const ok = await w.tool('verify_proof', { ...vectorArgs(), requestHash: VECTOR_REQUEST_HASH });
    expect(ok.json.ok).toBe(true);
    expect(ok.json.passed).toContain('request_hash');
    expect(ok.json.notChecked).not.toContain('request_hash');
    const bad = await w.tool('verify_proof', { ...vectorArgs(), requestHash: `0x${'ab'.repeat(32)}` });
    expect(bad.isError).toBe(true);
    expect(bad.json).toMatchObject({ ok: false, check: 'request_mismatch' });
  });

  it('request material (method, pathAndQuery, body) is hashed by SPEC §2.2 and compared; a different request is refused', async () => {
    w = await world(null);
    const r = await w.tool('verify_proof', { ...vectorArgs(), request: { method: 'POST', pathAndQuery: '/v1/evaluate', body: '{"a":1}' } });
    expect(r.json).toMatchObject({ ok: false, check: 'request_mismatch' });
    const junk = await w.tool('verify_proof', { ...vectorArgs(), request: { method: 'POST', pathAndQuery: 'no-slash', body: '{}' } });
    expect(junk.isError).toBe(true);
    expect(junk.json.error).toBe('usage');
  });

  it('without request material or a requestHash the result says the request hash was not checked, and the tool does not claim binding', async () => {
    w = await world(null);
    const r = await w.tool('verify_proof', vectorArgs());
    expect(r.json.notChecked).toContain('request_hash');
    expect(r.json.passed).not.toContain('request_hash');
    const { tools } = await w.client.listTools();
    expect(tools.find((t) => t.name === 'verify_proof')!.description).not.toMatch(/request binding/i);
  });
});

describe('mcp: Codex r1 Major 3, notChecked names every skipped check', () => {
  it('lists the chain, payment, settlement, time-anchor and inputs checks it cannot do offline', async () => {
    w = await world(null);
    const r = await w.tool('verify_proof', vectorArgs());
    expect(r.json.notChecked).toEqual(
      expect.arrayContaining([
        'request_id',
        'request_hash',
        'response_hash',
        'inputs_hash',
        'signer_active_on_chain',
        'release_approved_on_chain',
        'endpoint_agent_operator_on_chain',
        'payment_binding',
        'settlement',
        'time_anchors',
        'expiry_against_now',
        'inputs_block_and_values',
      ]),
    );
    expect(r.json.scope).toBe('offline');
  });
});

/** Calls to a gateway's result endpoint that carried a payer signature (`X-Attest-Payer-Sig`), i.e. a wallet signature. */
function spyPayerSigs() {
  const real = globalThis.fetch;
  const seen: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.includes('/v1/results/') && h.get('x-attest-payer-sig')) seen.push(url);
    return real(input, init);
  });
  return { seen, restore: () => spy.mockRestore() };
}

describe('mcp: Codex r1 Major 4, tools that sign a payer message say so', () => {
  it('status and get_result descriptions disclose the payer-message signature and are not marked read-only', async () => {
    w = await world();
    const { tools } = await w.client.listTools();
    for (const n of ['status', 'get_result']) {
      const t = tools.find((x) => x.name === n)!;
      expect(t.description).toMatch(/signs a payer message/i);
      expect(t.description).not.toMatch(/signs and spends nothing/i);
      expect(t.annotations?.readOnlyHint).toBe(false);
    }
    for (const n of ['resolve_endpoint', 'check_liveness', 'verify_proof', 'list_pending']) {
      expect(tools.find((x) => x.name === n)!.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('an open call: get_result and status each send a payer signature to the gateway (the disclosed behaviour)', async () => {
    w = await world();
    w.gw.behavior = { paid: 'pending_no_settle' };
    const paid = await w.tool('pay_and_verify', { url: w.url, body: w.body, noWait: true });
    expect(paid.json.outcome).not.toBe('verified');
    const id = paid.json.requestId as string;
    const spy = spyPayerSigs();
    try {
      const g = await w.tool('get_result', { requestId: id });
      expect(g.json.requestId).toBe(id);
      expect(spy.seen.length).toBeGreaterThan(0);
    } finally {
      spy.restore();
    }
  });

  it('quote, resolve_endpoint, check_liveness, verify_proof and list_pending never send a payer signature', async () => {
    w = await world();
    w.gw.behavior = { paid: 'pending_no_settle' };
    await w.tool('pay_and_verify', { url: w.url, body: w.body, noWait: true });
    const spy = spyPayerSigs();
    try {
      await w.tool('quote', { url: w.url, body: w.body });
      await w.tool('resolve_endpoint', { url: w.url });
      await w.tool('check_liveness', { url: w.url });
      await w.tool('list_pending');
      await w.tool('verify_proof', vectorArgs());
      expect(spy.seen).toEqual([]);
    } finally {
      spy.restore();
    }
  });
});

describe('mcp: Codex r1 Minor 1, a terminal failed outcome from get_result is the FLOWS row with a next action', () => {
  it('settled_after_refusal: isError, the FLOWS warning as message, one next action', async () => {
    w = await world();
    w.gw.behavior = { paid: 'refuse_but_settle' };
    const paid = await w.tool('pay_and_verify', { url: w.url, body: w.body, noWait: true });
    const id = paid.json.requestId as string;
    await w.tool('cancel_authorization', { requestId: id }); // too late: decides the call settled_after_refusal
    expect(w.pending()[0]).toMatchObject({ state: 'settled_after_refusal' });
    const g = await w.tool('get_result', { requestId: id });
    expect(g.isError).toBe(true);
    expect(g.json.ok).toBe(false);
    expect(g.json.outcome ?? g.json.state).toBe('settled_after_refusal');
    expect(g.json.message).toMatch(/the service refused this call, but your payment permission was used anyway/);
    expect(typeof g.json.next).toBe('string');
    expect(g.json.next.length).toBeGreaterThan(5);
  });
});

describe('mcp: Codex r1 Minor 2, cancel and open-call paths', () => {
  it('cancel_authorization on a refused open call sends the cancel and records not_charged', async () => {
    w = await world();
    w.gw.behavior = { paid: 'refuse' };
    const paid = await w.tool('pay_and_verify', { url: w.url, body: w.body, noWait: true });
    const id = paid.json.requestId as string;
    expect(w.pending()[0]).toMatchObject({ requestId: id });
    expect(w.pending()[0]!.state).not.toBe('not_charged');
    const c = await w.tool('cancel_authorization', { requestId: id });
    expect(c.isError).toBe(false);
    expect(c.json).toMatchObject({ ok: true, requestId: id, outcome: 'not_charged', code: 'cancelled' });
    expect(c.json.cancelTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.pending()[0]).toMatchObject({ state: 'not_charged', code: 'cancelled' });
    const again = await w.tool('get_result', { requestId: id });
    expect(again.json.state).toBe('not_charged');
  });

  it('an open call is listed, then decided by status from chain evidence only', async () => {
    w = await world();
    w.gw.behavior = { paid: 'pending_no_settle' };
    const paid = await w.tool('pay_and_verify', { url: w.url, body: w.body, noWait: true });
    const id = paid.json.requestId as string;
    const list = await w.tool('list_pending');
    expect(list.json.pending.map((e: { requestId: string }) => e.requestId)).toEqual([id]);
    expect(['settle_pending', 'uncertain', 'refused', 'signed']).toContain(list.json.pending[0].state);
    const s = await w.tool('status');
    // Nothing settled on the fake chain, and its clock passed validBefore during the reconcile: the chain decides not_charged,
    // with the block that decided it, and never `verified`.
    expect(s.json.pending).toHaveLength(1);
    expect(s.json.pending[0]).toMatchObject({ requestId: id, outcome: 'not_charged' });
    expect(s.json.pending[0].confirmedAtBlock).toMatch(/^\d+$/);
    expect(s.json.pending[0].settlementTx).toBeUndefined();
    expect(w.pending()[0]).toMatchObject({ state: 'not_charged' });
  });
});

describe('mcp: Codex r2 Major 1 (r3: refuse, never run with an unredactable secret)', () => {
  it('a one-character secret is refused with a next action on every tool; nothing is corrupted, nothing runs', async () => {
    w = await world(null);
    w.env.DEMO_TOKEN = '0';
    for (const [name, args] of [['verify_proof', vectorArgs()], ['list_pending', {}], ['status', {}]] as const) {
      const r = await w.tool(name, args);
      expect(r.isError).toBe(true);
      expect(r.json).toMatchObject({ ok: false, error: 'unsafe_secret' });
      expect(r.json.message).toContain('DEMO_TOKEN');
      expect(r.json.message).not.toMatch(/value is|"0"|= ?0/);
      expect(r.json.next).toMatch(/at least 4 characters/);
    }
    delete w.env.DEMO_TOKEN;
    const clean = await w.tool('verify_proof', vectorArgs());
    expect(clean.json.ok).toBe(true);
    expect(clean.text).toContain(VECTOR_REQUEST_HASH);
  });

  it('a secret of 4 or more characters is hidden inside strings only; 3 is refused', async () => {
    w = await world();
    w.env.LONG_TOKEN = 'abcd';
    const a = await w.tool('prefix-abcd-suffix');
    expect(a.text).not.toContain('abcd');
    expect(a.json.error).toBe('unknown_tool');
    w.env.SHORT_TOKEN = 'abc';
    const b = await w.tool('prefix-abc-suffix');
    expect(b.json.error).toBe('unsafe_secret');
    expect(b.text).not.toContain('abc-suffix');
  });
});

describe('mcp: Codex r2 Major 2, notChecked is complete on every failure path', () => {
  it('a failed request id still lists the request hash, response hash and inputs hash it never reached', async () => {
    w = await world(null);
    const r = await w.tool('verify_proof', { ...vectorArgs(), requestId: `0x${'ab'.repeat(32)}` });
    expect(r.json.check).toBe('request_mismatch');
    expect(r.json.notChecked).toEqual(expect.arrayContaining(['request_hash', 'response_hash', 'inputs_hash', 'lifetime', 'signer_active_on_chain', 'inputs_block_and_values']));
    expect(r.json.notChecked).not.toContain('request_id');
    expect(r.json.notChecked).not.toContain('signature');
  });

  it('a malformed proof and a bad signature list every other check as not made, even those whose argument was given', async () => {
    w = await world(null);
    const junk = await w.tool('verify_proof', { ...vectorArgs(), proof: 'not base64!', response: '{}', requestId: `0x${'ab'.repeat(32)}` });
    expect(junk.json.check).toBe('bad_signature');
    expect(junk.json.notChecked).toEqual(
      expect.arrayContaining(['request_id', 'request_hash', 'lifetime', 'response_hash', 'inputs_hash', 'signer_active_on_chain', 'settlement']),
    );
    const wrongRegistry = await w.tool('verify_proof', { ...vectorArgs(), registry: '0x0000000000000000000000000000000000000001' });
    expect(wrongRegistry.json.notChecked).toEqual(expect.arrayContaining(['request_id', 'request_hash', 'lifetime', 'response_hash', 'inputs_hash']));
    const badResponse = await w.tool('verify_proof', { ...vectorArgs(), response: '{"inputs":{}}' });
    expect(badResponse.json.check).toBe('response_hash_mismatch');
    expect(badResponse.json.notChecked).toEqual(expect.arrayContaining(['request_id', 'request_hash', 'inputs_hash']));
    expect(badResponse.json.notChecked).not.toContain('response_hash');
    expect(badResponse.json.notChecked).not.toContain('lifetime');
  });
});

describe('mcp: Codex r2 Minor 1, status says exactly when it signs', () => {
  it('status does not sign for an open call already refused; its description says signing is conditional', async () => {
    w = await world();
    w.gw.behavior = { paid: 'refuse' };
    const paid = await w.tool('pay_and_verify', { url: w.url, body: w.body, noWait: true });
    expect(w.pending()[0]).toMatchObject({ requestId: paid.json.requestId, state: 'refused' });
    const spy = spyPayerSigs();
    try {
      await w.tool('status');
      expect(spy.seen).toEqual([]);
    } finally {
      spy.restore();
    }
    const { tools } = await w.client.listTools();
    const d = tools.find((t) => t.name === 'status')!.description!;
    expect(d).not.toMatch(/per open call/i);
    expect(d).toMatch(/already refused/i);
  });

  it('status signs a payer message for an open call whose answer can still come', async () => {
    w = await world();
    w.gw.behavior = { paid: 'pending_no_settle' };
    await w.tool('pay_and_verify', { url: w.url, body: w.body, noWait: true });
    expect(w.pending()[0]!.state).not.toBe('refused');
    const spy = spyPayerSigs();
    try {
      await w.tool('status');
      expect(spy.seen.length).toBeGreaterThan(0);
    } finally {
      spy.restore();
    }
  });
});

describe('mcp: Codex r3 Major 1, an unredactable secret stops the server; every encoding is hidden', () => {
  const deps = (env: Record<string, string | undefined>) => ({
    env,
    cwd: '/tmp',
    rpc: () => {
      throw new Error('no rpc');
    },
    runner: { run: async () => ({ code: 1, stdout: '', stderr: '' }) },
    fetch,
    enclave: () => {
      throw new Error('no enclave');
    },
    readFile: (p: string) => readFileSync(p),
    writeFile: () => {},
    exists: () => false,
    readdir: () => [],
    sleep: async () => {},
    arch: 'x64',
  });

  it('createMcpServer refuses to start for a too-short or all-digit secret, naming the variable and a next action, never the value', () => {
    for (const [name, value] of [['ATTESSA_KEYSTORE_PASSWORD', 'ab'], ['SERVICE_TOKEN', '1234567'], ['DEMO_SECRET', 'x']] as const) {
      let err: Error | undefined;
      try {
        createMcpServer({ deps: deps({ [name]: value }) });
      } catch (e) {
        err = e as Error;
      }
      expect(err, name).toBeDefined();
      expect(err!.message).toContain(name);
      expect(err!.message).not.toContain(`"${value}"`);
      expect((err as { next?: string }).next).toMatch(/at least 4 characters|digits/);
    }
    expect(() => createMcpServer({ deps: deps({ SERVICE_TOKEN: '12345678', KEYBOARD: 'us', AUTHOR: 'x', ATTESSA_NETWORK: 'local' }) })).not.toThrow();
  });

  it('through the result path: JSON-escaped, mixed-case percent, plus-for-space and encodeURI spellings are hidden', async () => {
    w = await world();
    w.env.JSON_TOKEN = 'tok"en\\q';
    w.env.PCT_SECRET = 'k/e:y!~x';
    w.env.SPACE_PASSWORD = 'a b+c d';
    const leaks = [
      'tok\\"en\\\\q', // the JSON-escaped spelling of JSON_TOKEN
      'tok"en\\q',
      'k%2fe%3Ay%21~x', // mixed-case percent escapes
      'k%2Fe%3ay%21~x',
      'k%2fe%3ay%21~x',
      'k/e:y!~x',
      'k%2Fe%3Ay!~x',
      'a+b%2Bc+d',
      'a%20b%2bc%20d',
      'a b+c d',
    ];
    for (const leak of leaks) {
      const r = await w.tool(`pre-${leak}-post`);
      expect(r.isError, leak).toBe(true);
      expect(r.json.error, leak).toBe('unknown_tool');
      expect(r.text, leak).not.toContain(leak);
      expect(r.text, leak).not.toContain(JSON.stringify(leak).slice(1, -1));
      expect(r.text).toContain('pre-');
    }
  });
});

describe('mcp: Codex r3 Major 2, verify_proof says what it skipped even when the call is refused before any check', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['no proof', { chainId: 11142220 }, 'usage'],
    ['bad chainId', { proof: 'x', chainId: 'eleven' }, 'usage'],
    ['bad registry', { proof: 'x', chainId: 11142220, registry: '0x12' }, 'usage'],
    ['unpinned chain', { proof: 'x', chainId: 31337 }, 'no_registry'],
    ['bad requestId', { proof: 'x', chainId: 11142220, requestId: '0x12' }, 'usage'],
    ['bad requestHash', { proof: 'x', chainId: 11142220, requestHash: 'nope' }, 'usage'],
    ['bad request', { proof: 'x', chainId: 11142220, request: { method: 'POST', pathAndQuery: 'no-slash', body: '' } }, 'usage'],
  ];
  for (const [label, args, code] of cases) {
    it(label, async () => {
      w = await world(null);
      const r = await w.tool('verify_proof', args);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe(code);
      expect(r.json.next).toBeTruthy();
      expect(r.json.scope).toBe('offline');
      expect(r.json.notChecked).toEqual(
        expect.arrayContaining(['signature', 'request_id', 'request_hash', 'lifetime', 'response_hash', 'inputs_hash', 'signer_active_on_chain', 'settlement', 'inputs_block_and_values']),
      );
    });
  }
});

describe('mcp: Codex r3 Minor 1, get_result says when it signs', () => {
  it('get_result does not sign for an open call already refused; its description says so', async () => {
    w = await world();
    w.gw.behavior = { paid: 'refuse' };
    const paid = await w.tool('pay_and_verify', { url: w.url, body: w.body, noWait: true });
    expect(w.pending()[0]).toMatchObject({ requestId: paid.json.requestId, state: 'refused' });
    const spy = spyPayerSigs();
    try {
      await w.tool('get_result', { requestId: paid.json.requestId });
      expect(spy.seen).toEqual([]);
    } finally {
      spy.restore();
    }
    const { tools } = await w.client.listTools();
    const d = tools.find((t) => t.name === 'get_result')!.description!;
    expect(d).not.toMatch(/for each open call/i);
    expect(d).toMatch(/already refused/i);
  });
});
