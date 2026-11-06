import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { keccak256, stringToBytes, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
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
