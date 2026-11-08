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
import { takeEnvironment } from '../src/env.ts';
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
    env: { ATTESSA_REGISTRY: chain.registry, ATTESSA_PRIVATE_KEY: key, ATTESSA_NETWORK: 'local', ATTESSA_RPC: 'http://127.0.0.1:1', ATTESSA_DATA_DIR: dataDir, ATTESSA_REDACT: 'FACILITATOR_API_KEY,SERVICE_TOKEN,JSON_TOKEN,PCT_SECRET,SPACE_PASSWORD,DEMO_TOKEN,LONG_TOKEN,SHORT_TOKEN' } as Record<string, string | undefined>,
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
    /**
     * Puts `text` through a real result path that still carries a string: a verified call's kept answer (a service's answer passed
     * through) comes back in `response` of `get_result`. The first call pays once (fake gateway), later ones rewrite the kept file.
     */
    async echo(text: string) {
      if (w.echoId === undefined) {
        const paid = await w.tool('pay_and_verify', { url: w.url, body: w.body });
        w.echoId = paid.json.requestId as string;
      }
      writeFileSync(join(dataDir, `${w.echoId}.json`), text);
      const r = await w.tool('get_result', { requestId: w.echoId });
      return { ...r, response: r.json.response as string | undefined };
    },
    echoId: undefined as string | undefined,
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
    const env = { ATTESSA_REDACT: 'FACILITATOR_API_KEY', ATTESSA_PRIVATE_KEY: `0x${'ab'.repeat(32)}`, ATTESSA_KEYSTORE_PASSWORD: 'hunter2-hunter2', FACILITATOR_API_KEY: 'fac-secret-123' };
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
    // A service's answer passed through (a verified call's kept answer) carries any string back through the real result path.
    for (const leak of ['abc123', 'p@ss w/rd&1', encodeURIComponent('p@ss w/rd&1'), 'x"y\\zzz']) {
      const r = await w.echo(`prefix-${leak}-suffix`);
      expect(r.text).not.toContain(leak);
      expect(r.text).not.toContain(JSON.stringify(leak).slice(1, -1));
      expect(r.response).toBe('prefix-[hidden]-suffix');
    }
  });

  it('scrub: short secrets, encodings and an empty value (nothing to hide, nothing mangled)', () => {
    const env = { ATTESSA_REDACT: 'EMPTY_SECRET,FACILITATOR_API_KEY', ATTESSA_KEYSTORE_PASSWORD: 'abc123', EMPTY_SECRET: '', FACILITATOR_API_KEY: 'a b&c' };
    const out = scrub(`pw abc123 enc ${encodeURIComponent('a b&c')} plus a+b%26c raw a b&c`, env);
    expect(out).not.toMatch(/abc123|a b&c|a%20b%26c/);
    expect(out.startsWith('pw ')).toBe(true);
  });
});

const UNKNOWN_TOOL_MESSAGE = 'There is no tool with that name.';
const WITHHELD_RESULT = {
  ok: false,
  error: 'redaction_withheld',
  message: 'The result was withheld because it would have shown a secret this server holds, or hiding it would have changed a number or a hash.',
  next: 'Check what you passed in and what the service returned; if the secret was exposed outside this server, replace it.',
};

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
    const a = await w.echo('prefix-abcd-suffix');
    expect(a.text).not.toContain('abcd');
    expect(a.response).toBe('prefix-[hidden]-suffix');
    w.env.SHORT_TOKEN = 'abc';
    const b = await w.echo('prefix-abc-suffix');
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
        createMcpServer({ deps: deps({ [name]: value, ATTESSA_REDACT: name }) });
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
    // One explicit outcome per spelling, through a real result path (a service's answer passed through):
    // `hidden` = replaced in place, the text around it kept; `withheld` = the exact fixed redaction_withheld result.
    const leaks: Array<[string, 'hidden' | 'withheld']> = [
      ['tok\\"en\\\\q', 'withheld'], // the JSON-escaped spelling of JSON_TOKEN, typed as text: reads back as the secret once unescaped
      ['tok"en\\q', 'hidden'],
      ['k%2fe%3Ay%21~x', 'hidden'], // mixed-case percent escapes
      ['k%2Fe%3ay%21~x', 'hidden'],
      ['k%2fe%3ay%21~x', 'hidden'],
      ['k/e:y!~x', 'hidden'],
      ['k%2Fe%3Ay!~x', 'hidden'],
      ['a+b%2Bc+d', 'hidden'],
      ['a%20b%2bc%20d', 'hidden'],
      ['a b+c d', 'hidden'],
    ];
    for (const [leak, outcome] of leaks) {
      const r = await w.echo(`pre-${leak}-post`);
      expect(r.text, leak).not.toContain(leak);
      expect(r.text, leak).not.toContain(JSON.stringify(leak).slice(1, -1));
      if (outcome === 'hidden') {
        expect(r.response, leak).toBe('pre-[hidden]-post');
        expect(r.json.ok, leak).toBe(true);
      } else {
        expect(r.isError, leak).toBe(true);
        expect(r.json, leak).toEqual(WITHHELD_RESULT);
      }
    }
  });

  it('an unknown tool name is never echoed, in any spelling', async () => {
    w = await world();
    w.env.JSON_TOKEN = 'tok"en\\q';
    for (const name of ['pre-x-post', 'tok"en\\q', 'pre-tok%22en-post', 'a\nb', '', 'x'.repeat(5000)]) {
      const r = await w.tool(name);
      expect(r.isError).toBe(true);
      expect(r.json).toEqual({ ok: false, error: 'unknown_tool', message: UNKNOWN_TOOL_MESSAGE, next: 'List the tools with tools/list.' });
      if (name !== '') expect(r.text).not.toContain(name);
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

describe('mcp: Codex r4, the secrets are exactly what the server consumes, and none reaches a result', () => {
  const declared = (w: W, secret: string) => {
    w.env.ATTESSA_REDACT = 'DEMO_TOKEN';
    w.env.DEMO_TOKEN = secret;
  };

  it('Major 1: a declared secret does not leave through safe(), \\xNN, \\u{N}, \\uNNNN or \\/ spellings; the result is withheld, never altered', async () => {
    w = await world();
    declared(w, 'ab\ncd');
    // Raw: hidden in place. Every escaped spelling reads back as the secret once unescaped: the fixed withheld result.
    const raw = await w.echo('pre-ab\ncd-post');
    expect(raw.response).toBe('pre-[hidden]-post');
    for (const text of ['pre-ab\\x0acd-post', 'pre-ab\\u{a}cd-post', 'pre-ab\\u000acd-post', 'pre-ab\\ncd-post']) {
      const r = await w.echo(text);
      expect(r.isError, text).toBe(true);
      expect(r.json, text).toEqual(WITHHELD_RESULT);
      expect(r.text, text).not.toContain('x0a');
    }
    declared(w, 'token');
    const plain = await w.echo('pre-token-post');
    expect(plain.response).toBe('pre-[hidden]-post');
    // Each escaped spelling of an unreserved letter reads back as the secret: withheld. Only a literal `token` is hidden in place.
    for (const text of ['pre-\\u0074oken-post', 'pre-t\\u006fken-post', 'pre-\\x74oken-post', 'pre-%74oken-post', 'pre-tok%65n-post']) {
      const r = await w.echo(text);
      expect(r.isError, text).toBe(true);
      expect(r.json, text).toEqual(WITHHELD_RESULT);
      expect(r.text, text).not.toMatch(/u0074|u006f|x74|%74|%65|token/i);
    }
    const slash = await w.echo('pre-\\/token-post');
    expect(slash.response).toBe('pre-\\/[hidden]-post');
  });

  it('Major 2: a key under any other variable name is neither required nor touched, and nothing about its name matters', async () => {
    w = await world();
    const wallet = `0x${'11'.repeat(32)}`;
    w.env.WALLET = wallet;
    w.env.DATABASE_URL = 'postgres://user:pw@db/x';
    w.env.SOME_TOKEN = '1'; // undeclared: the server reads it for nothing, so it is not its to hide or refuse
    w.env.KEYBOARD = 'us';
    const r = await w.echo(`pre-${wallet}-post`);
    expect(r.response).toBe(`pre-${wallet}-post`);
    expect(r.text).toContain(wallet); // not declared in ATTESSA_REDACT: documented, not hidden
    const ok = await w.tool('list_pending');
    expect(ok.json.ok).toBe(true);
    w.env.ATTESSA_REDACT = 'WALLET';
    const hidden = await w.echo(`pre-${wallet}-post`);
    expect(hidden.text).not.toContain(wallet);
  });

  it('the consumed secrets are fixed: the key and keystore password need no declaration', async () => {
    w = await world();
    const pw = 'hunter2-hunter2';
    w.env.ATTESSA_KEYSTORE_PASSWORD = pw;
    for (const leak of [pw, w.key, w.key.slice(2)]) {
      const r = await w.echo(`pre-${leak}-post`);
      expect(r.text).not.toContain(leak);
    }
    w.env.ATTESSA_KEYSTORE_PASSWORD = 'ab';
    expect((await w.tool('list_pending')).json.error).toBe('unsafe_secret');
  });

  it('an RPC URL with credentials is never in a result: scheme://host only, and its userinfo, path and query values are hidden if echoed', async () => {
    w = await world();
    w.env.ATTESSA_RPC = 'https://rpcuser:pw-s3cret@rpc.example:8545/v3/APIKEY-abc123?key=queryTok99#fragTok77';
    w.chain.failing.add('eth_chainId');
    const r = await w.tool('resolve_endpoint', { url: w.url });
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/rpcuser|pw-s3cret|APIKEY-abc123|queryTok99|fragTok77/);
    for (const part of ['rpcuser', 'pw-s3cret', 'APIKEY-abc123', 'queryTok99', 'fragTok77', 'pw%2Ds3cret']) {
      const e = await w.echo(`pre-${part}-post`);
      expect(e.text, part).not.toContain(part);
    }
  });

  it('final layer: a redaction that would change a number, a hash or the JSON structure withholds the result instead', async () => {
    w = await world(null);
    // A declared secret that equals the digits of the vector's request hash tail: replacing it would corrupt a hash.
    declared(w, VECTOR_REQUEST_HASH.slice(10, 30));
    const r = await w.tool('verify_proof', vectorArgs());
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe('redaction_withheld');
    expect(r.json.next).toBeTruthy();
    expect(r.text).not.toContain(VECTOR_REQUEST_HASH.slice(10, 30));
  });

  it('final layer: a structure-breaking secret withholds the result and the text still parses', async () => {
    w = await world();
    const r0 = await w.echo('x'); // pays once, so the serialised result below is a verified one
    expect(r0.json.state).toBe('verified');
    declared(w, 'verified","amount":"'); // present in the serialised result: replacing it would merge two members
    const r = await w.tool('get_result', { requestId: w.echoId });
    expect(r.isError).toBe(true);
    expect(() => JSON.parse(r.text)).not.toThrow();
    expect(r.json.error).toBe('redaction_withheld');
  });
});

describe('mcp: Codex r5, removing the paths first', () => {
  it('takeEnvironment returns a private copy and removes the key and keystore password from the source', () => {
    const source: Record<string, string | undefined> = { ATTESSA_PRIVATE_KEY: `0x${'11'.repeat(32)}`, ATTESSA_KEYSTORE_PASSWORD: 'pw-pw-pw-pw', ATTESSA_NETWORK: 'local', HOME: '/h' };
    const copy = takeEnvironment(source);
    expect(copy).toEqual({ ATTESSA_PRIVATE_KEY: `0x${'11'.repeat(32)}`, ATTESSA_KEYSTORE_PASSWORD: 'pw-pw-pw-pw', ATTESSA_NETWORK: 'local', HOME: '/h' });
    expect(source).toEqual({ ATTESSA_NETWORK: 'local', HOME: '/h' });
    expect('ATTESSA_PRIVATE_KEY' in source).toBe(false);
    expect('ATTESSA_KEYSTORE_PASSWORD' in source).toBe(false);
    copy.ATTESSA_NETWORK = 'mainnet'; // the copy is not the source
    expect(source.ATTESSA_NETWORK).toBe('local');
  });

  it('takeEnvironment works on the real process.env', () => {
    const saved = { k: process.env.ATTESSA_PRIVATE_KEY, p: process.env.ATTESSA_KEYSTORE_PASSWORD };
    process.env.ATTESSA_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
    process.env.ATTESSA_KEYSTORE_PASSWORD = 'synthetic-pw-1';
    try {
      const copy = takeEnvironment(process.env);
      expect(copy.ATTESSA_PRIVATE_KEY).toBe(`0x${'22'.repeat(32)}`);
      expect(process.env.ATTESSA_PRIVATE_KEY).toBeUndefined();
      expect(process.env.ATTESSA_KEYSTORE_PASSWORD).toBeUndefined();
    } finally {
      for (const [n, v] of [['ATTESSA_PRIVATE_KEY', saved.k], ['ATTESSA_KEYSTORE_PASSWORD', saved.p]] as const) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });

  it('nothing on the MCP call path reads the key from process.env: the server wallet is the deps.env one', async () => {
    w = await world();
    const other = generatePrivateKey();
    const saved = process.env.ATTESSA_PRIVATE_KEY;
    process.env.ATTESSA_PRIVATE_KEY = other;
    try {
      // deps.env has no key and process.env has one: the wallet must not be found.
      delete w.env.ATTESSA_PRIVATE_KEY;
      const r = await w.tool('status');
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain(privateKeyToAccount(other).address.toLowerCase());
      // and with deps.env's key, the wallet that answers is that one, not process.env's
      w.env.ATTESSA_PRIVATE_KEY = w.key;
      const ok = await w.tool('status');
      expect(ok.isError).toBe(false);
      expect(ok.text.toLowerCase()).not.toContain(privateKeyToAccount(other).address.toLowerCase());
    } finally {
      if (saved === undefined) delete process.env.ATTESSA_PRIVATE_KEY;
      else process.env.ATTESSA_PRIVATE_KEY = saved;
    }
  });

  it('r5 reproduction: a nonexistent keystore path with a marker never reaches a bad_key result', async () => {
    w = await world();
    delete w.env.ATTESSA_PRIVATE_KEY;
    w.env.ATTESSA_KEYSTORE = '/nonexistent/KSMARKER-7731/keystore.json';
    w.env.ATTESSA_KEYSTORE_PASSWORD = 'synthetic-safe-pw';
    const r = await w.tool('status');
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe('bad_key');
    expect(r.text).not.toContain('KSMARKER');
    expect(r.text).not.toContain('/nonexistent');
  });

  it('ATTESSA_KEYSTORE is a path, not a secret: a short value is never refused as unsafe_secret, and is still hidden whole', async () => {
    w = await world();
    await w.echo('x'); // pays once, with the key
    delete w.env.ATTESSA_PRIVATE_KEY;
    w.env.ATTESSA_KEYSTORE = 'ks';
    w.env.ATTESSA_KEYSTORE_PASSWORD = 'synthetic-safe-pw';
    expect((await w.tool('list_pending')).json.ok).toBe(true);
    w.env.ATTESSA_REDACT = `${w.env.ATTESSA_REDACT},ATTESSA_KEYSTORE,ATTESSA_DATA_DIR`;
    expect((await w.tool('list_pending')).json.ok).toBe(true); // even when the operator lists a path in ATTESSA_REDACT
    const r = await w.echo('opened ks and ksx and /tmp/ks/y');
    expect(r.response).toBe('opened [hidden] and ksx and /tmp/ks/y');
    const st = await w.tool('status');
    expect(st.json.error).toBe('bad_key');
    expect(st.text).not.toMatch(/\bks\b/);
  });

  it('ATTESSA_DATA_DIR, as typed and in its ~/ display form, never appears whole in a result', async () => {
    w = await world();
    const rel = w.dataDir.slice(w.home.length); // /.attessa
    for (const form of [w.dataDir, `~${rel}`, `${w.dataDir}/evidence.jsonl`, `~${rel}/evidence.jsonl`]) {
      const r = await w.echo(`see ${form}, which holds records`);
      expect(r.text, form).not.toContain(w.dataDir);
      expect(r.text, form).not.toContain(`~${rel}`);
      expect(r.response, form).toMatch(/^see \[hidden\]/);
    }
    // the CLI's own error path: a config.json that is not JSON names its path
    writeFileSync(join(w.dataDir, 'config.json'), 'not json');
    const st = await w.tool('status');
    expect(st.isError).toBe(true);
    expect(st.text).not.toContain(w.dataDir);
    expect(st.text).not.toContain(`~${rel}`);
    expect(st.json.error).toBe('usage');
  });

  it('a short ATTESSA_DATA_DIR is not an unsafe_secret either', async () => {
    w = await world();
    w.env.ATTESSA_DATA_DIR = 'd';
    expect((await w.tool('list_pending')).json.error).not.toBe('unsafe_secret');
  });

  it('ATTESSA_NETWORK and ATTESSA_REGISTRY are public configuration: a bad value is a fixed refusal that does not echo it', async () => {
    w = await world();
    w.env.ATTESSA_NETWORK = 'NETMARKER-5521';
    const n = await w.tool('resolve_endpoint', { url: w.url });
    expect(n.isError).toBe(true);
    expect(n.json).toMatchObject({ error: 'usage', message: '--network must be sepolia, mainnet or local.' });
    expect(n.text).not.toContain('NETMARKER');
    w.env.ATTESSA_NETWORK = 'local';
    w.env.ATTESSA_REGISTRY = 'REGMARKER-9942';
    const g = await w.tool('resolve_endpoint', { url: w.url });
    expect(g.isError).toBe(true);
    expect(g.json).toMatchObject({ error: 'usage', message: 'ATTESSA_REGISTRY must be an address.' });
    expect(g.text).not.toContain('REGMARKER');
  });

  it('maxAmount is not echoed when it is over the limit', async () => {
    w = await world();
    const r = await w.tool('pay_and_verify', { url: w.url, body: w.body, maxAmount: '987654.321' });
    expect(r.json.error).toBe('over_max_amount');
    expect(r.text).not.toContain('987654');
  });
});

describe('mcp: Codex r5, encodings are matched to a fixed point and in base64 and hex', () => {
  const SECRET = 'sYnth3tic-S3cret!Value';
  const layers = (s: string, n: number): string => {
    let t = [...Buffer.from(s, 'utf8')].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');
    for (let i = 1; i < n; i++) t = t.replace(/%/g, '%25');
    return t;
  };
  const b64s = (bytes: Buffer): string[] => {
    const std = bytes.toString('base64');
    return [std, std.replace(/=+$/, ''), std.replace(/\+/g, '-').replace(/\//g, '_'), std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')];
  };

  it('five and more percent layers are hidden or withheld, never shown', async () => {
    w = await world();
    w.env.DEMO_TOKEN = SECRET;
    for (const n of [4, 5, 6, 9, 20, 60]) {
      const r = await w.echo(`pre-${layers(SECRET, n)}-post`);
      expect(r.text, `${n}`).not.toContain(layers(SECRET, n));
      expect(r.json, `${n}`).toEqual(WITHHELD_RESULT);
    }
  });

  it('a nesting deeper than the bound is withheld whole, even when no secret is in it', async () => {
    w = await world();
    let s = '%41';
    for (let i = 0; i < 200; i++) s = s.replace(/%/g, '%25');
    const r = await w.echo(`x ${s} y`);
    expect(r.isError).toBe(true);
    expect(r.json).toEqual(WITHHELD_RESULT);
  });

  it('base64 (standard and URL-safe, padded or not, at all three alignments) and hex (either case) of a secret are withheld', async () => {
    w = await world();
    w.env.DEMO_TOKEN = SECRET;
    const forms: Array<[string, string]> = [];
    for (const k of [0, 1, 2]) {
      const bytes = Buffer.concat([Buffer.from('x'.repeat(k)), Buffer.from(SECRET), Buffer.from('tail!')]);
      for (const f of b64s(bytes)) forms.push([`b64 k=${k}`, f]);
      for (const f of b64s(Buffer.concat([Buffer.from('x'.repeat(k)), Buffer.from(SECRET)]))) forms.push([`b64 end k=${k}`, f]);
    }
    const hex = Buffer.from(SECRET).toString('hex');
    forms.push(['hex lower', hex], ['hex upper', hex.toUpperCase()], ['hex 0x', `0x${hex}`], ['hex in text', `data=${hex}ff`]);
    forms.push(['b64 then percent', encodeURIComponent(Buffer.from(`k${SECRET}`).toString('base64'))]);
    for (const [label, f] of forms) {
      const r = await w.echo(`pre-${f}-post`);
      expect(r.isError, `${label} ${f}`).toBe(true);
      expect(r.json, `${label} ${f}`).toEqual(WITHHELD_RESULT);
    }
  });

  it('the base64 of a hex key as bytes is withheld too', async () => {
    w = await world();
    const bytes = Buffer.from(w.key.slice(2), 'hex');
    for (const f of b64s(bytes)) {
      const r = await w.echo(`k ${f}`);
      expect(r.json, f).toEqual(WITHHELD_RESULT);
    }
  });

  it('ordinary data is not withheld: a long base64 answer, 0x hashes, and the encoded form of a secret under 8 characters', async () => {
    w = await world();
    w.env.DEMO_TOKEN = SECRET;
    w.env.LONG_TOKEN = 'abcd1'; // 5 characters: hidden raw, but its encoded forms are not looked for
    const blob = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 37 + 11) % 256)).toString('base64');
    const hash = keccak256(stringToBytes('ordinary'));
    const text = JSON.stringify({ score: 0.91, blob, hash, hashes: [hash, `0x${'ab'.repeat(32)}`] });
    const r = await w.echo(text);
    expect(r.isError).toBe(false);
    expect(r.response).toBe(text);
    const short = await w.echo(`enc ${Buffer.from('abcd1').toString('base64')} ${Buffer.from('abcd1').toString('hex')}`);
    expect(short.isError).toBe(false);
    expect(short.response).toBe(`enc ${Buffer.from('abcd1').toString('base64')} ${Buffer.from('abcd1').toString('hex')}`);
  });
});
