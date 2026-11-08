import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuyCliSource, CAPABILITY_ID, MAX_AMOUNT_CEILING_ATOMIC, atomicToDecimal, type Exec } from '../src/buy.ts';
import { parseConfig } from '../src/config.ts';
import { BuySpendGuard } from '../src/guard.ts';
import { HttpRpcSource, InputFetcher } from '../src/inputs.ts';
import { FakeRpc } from './fake-rpc.ts';

// TEST DOUBLES: `exec` stands in for the `buy` binary. No real buy process, wallet or payment is involved,
// and the capability id, URL and price below are placeholders, not the real capability (T27 is not done).
const PAY_TO = '0x2222222222222222222222222222222222222222';
const SECRET = 'AGENT-KEY-SENTINEL-0123456789';
const CFG = { capabilityId: 'test-capability', url: 'https://buy.example.test/rpc', maxAmountAtomic: 10_000n };
const NOW = new Date('2026-11-10T12:00:00Z');

let forno: FakeRpc;
let paid: FakeRpc;
beforeEach(async () => {
  forno = new FakeRpc();
  paid = new FakeRpc();
  await forno.start();
  await paid.start();
  for (const r of [forno, paid]) r.accounts.set(PAY_TO, { code: '0x6001', nonce: 1n, balance: 5n });
});
afterEach(async () => {
  await forno.stop();
  await paid.stop();
});

/** An exec double that answers the `--data` batch from a FakeRpc, or misbehaves. */
function execDouble(mode: 'ok' | 'garbage' | 'reject' | 'wrong_block' | 'object') {
  const seen: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const exec: Exec = async (file, args, opts) => {
    seen.push({ file, args, env: opts.env });
    if (mode === 'reject') throw Object.assign(new Error(`stderr says ${SECRET}`), { code: 1 });
    if (mode === 'garbage') return { stdout: '<html>402</html>' };
    if (mode === 'object') return { stdout: JSON.stringify({ error: 'payment failed' }) };
    paid.mode = mode === 'wrong_block' ? 'wrong_block' : 'ok';
    const body = args[args.indexOf('--data') + 1]!;
    const res = await fetch(paid.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return { stdout: await res.text() };
  };
  return { exec, seen };
}

function fetcher(mode: Parameters<typeof execDouble>[0], revenue = 0n, cfg = CFG) {
  const d = execDouble(mode);
  const logs: Array<[string, unknown]> = [];
  const buy = new BuyCliSource(cfg, d.exec, { PATH: '/bin', HOME: '/h', AGENT_PRIVATE_KEY: SECRET });
  const guard = new BuySpendGuard(join(mkdtempSync(join(tmpdir(), 'attessa-buy-')), 'g.json'), { settledSince: () => revenue });
  const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy, guard, timeoutMs: 1000, log: (e, x) => logs.push([e, x]) });
  return { f, guard, logs, ...d };
}

describe('buy inputs (T28)', () => {
  it('inputs: reads through buy as one batch of the four reads and records source buy:<id>', async () => {
    const { f, seen, guard } = fetcher('ok');
    const i = await f.fetch(PAY_TO, NOW);
    expect(i.source).toBe('buy:test-capability');
    expect(seen).toHaveLength(1);
    const body = JSON.parse(seen[0]!.args[seen[0]!.args.indexOf('--data') + 1]!) as Array<{ method: string }>;
    expect(body.map((c) => c.method)).toEqual(['eth_getBlockByNumber', 'eth_getCode', 'eth_getTransactionCount', 'eth_getBalance']);
    expect(i.payTo).toMatchObject({ code: '0x6001', nonce: '1', balanceWei: '5' });
    expect(guard.state(NOW).spentAtomic).toBe('10000');
  });

  it('inputs: bounds spend with --max-amount, runs buy with a minimal env, and the key is nowhere in argv or env', async () => {
    const { f, seen } = fetcher('ok');
    await f.fetch(PAY_TO, NOW);
    const { file, args, env } = seen[0]!;
    expect(file).toBe('buy');
    expect(args.slice(0, 3)).toEqual(['curl', '--max-amount', '0.010000']);
    expect(args.at(-1)).toBe(CFG.url);
    expect(JSON.stringify([args, env])).not.toContain(SECRET);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
  });

  it('inputs: a failed buy read falls back to Forno once, says so, counts the spend, and is never retried', async () => {
    const { f, seen, logs, guard } = fetcher('reject');
    const i = await f.fetch(PAY_TO, NOW);
    expect(i.source).toBe('forno');
    expect(seen).toHaveLength(1);
    expect(logs.map(([e]) => e)).toContain('inputs_primary_failed');
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(guard.state(NOW).spentAtomic).toBe('10000');
  });

  it.each(['garbage', 'object', 'wrong_block'] as const)('inputs: a buy reply that fails validation (%s) counts as failed, source is forno', async (mode) => {
    const { f, seen } = fetcher(mode);
    expect((await f.fetch(PAY_TO, NOW)).source).toBe('forno');
    expect(seen).toHaveLength(1);
  });

  it('inputs: over the daily budget buy is not called at all', async () => {
    const { f, seen, guard } = fetcher('ok');
    guard.record(995_000n, NOW); // 0 revenue + 1 USDC budget leaves 5,000; a read costs 10,000
    expect((await f.fetch(PAY_TO, NOW)).source).toBe('forno');
    expect(seen).toHaveLength(0);
  });

  it('inputs: the per-call maximum is validated: ceiling, positive, https only', () => {
    const ok = (c: Partial<typeof CFG>) => new BuyCliSource({ ...CFG, ...c }, execDouble('ok').exec);
    expect(() => ok({ maxAmountAtomic: MAX_AMOUNT_CEILING_ATOMIC + 1n })).toThrow(/ceiling/);
    expect(() => ok({ maxAmountAtomic: 0n })).toThrow(/positive/);
    expect(() => ok({ url: 'http://buy.example.test/rpc' })).toThrow(/https/);
    expect(() => ok({ url: 'https://u:p@buy.example.test/rpc' })).toThrow(/credentials/);
    expect(() => ok({ capabilityId: 'has space' })).toThrow(/capabilityId/);
    expect(atomicToDecimal(10_000n)).toBe('0.010000');
    expect(atomicToDecimal(MAX_AMOUNT_CEILING_ATOMIC)).toBe('0.100000');
  });

  describe('config', () => {
    const base = {
      network: 'mainnet',
      registry: '0x' + '1'.repeat(40),
      agentId: '1',
      origin: 'https://attessa.example.com',
      stateDir: '/tmp/s',
      gatewayDbPath: '/tmp/g.db',
      buy: { capabilityId: 'x', url: 'https://buy.example.test/rpc', maxAmount: '0.01' },
    };
    it('inputs: parses a mainnet buy block into atomic units', () => {
      expect(parseConfig(base).buy).toMatchObject({ capabilityId: 'x', maxAmountAtomic: 10_000n });
    });
    it('inputs: no buy block means Forno only', () => {
      const { buy: _b, ...rest } = base;
      expect(parseConfig(rest).buy).toBeNull();
    });
    it('inputs: refuses paid reads on sepolia and local, without a gateway db, or over the ceiling', () => {
      expect(() => parseConfig({ ...base, network: 'sepolia' })).toThrow(/mainnet only/);
      expect(() => parseConfig({ ...base, network: 'local', chainId: 31337, enclavePort: 1, listen: { port: 2 }, fornoUrl: 'http://127.0.0.1:1' })).toThrow(/mainnet only/);
      expect(() => parseConfig({ ...base, gatewayDbPath: undefined })).toThrow(/gatewayDbPath/);
      expect(() => parseConfig({ ...base, buy: { ...base.buy, maxAmount: '1' } })).toThrow(/ceiling/);
      expect(() => parseConfig({ ...base, buy: { ...base.buy, maxAmount: '0.0000001' } })).toThrow(/decimal/);
    });
  });
});

// Fixes after the T28 adversary pass (round 1). Test doubles only; no real buy, wallet or payment.
describe('buy inputs (T28) round 1 fixes', () => {
  const calls = [{ method: 'eth_blockNumber', params: [] as unknown[] }];
  const parent = { PATH: '/bin', HOME: '/h', AGENT_PRIVATE_KEY: SECRET, BUY_FACILITATOR_URL: 'https://x.test', BUY_IMPORT_KEY: SECRET };

  it('env: keystoreBackend from config reaches the child, with the keychain session vars; no secret does', async () => {
    const d = execDouble('ok');
    const src = new BuyCliSource({ ...CFG, keystoreBackend: 'file', home: '/var/lib/buy' }, d.exec, { ...parent, XDG_RUNTIME_DIR: '/run/u', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/u/bus' });
    await src.batch(calls, AbortSignal.timeout(1000)).catch(() => {});
    const env = d.seen[0]!.env;
    expect(env).toMatchObject({ BUY_KEYSTORE_BACKEND: 'file', BUY_HOME: '/var/lib/buy', XDG_RUNTIME_DIR: '/run/u' });
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(env.BUY_IMPORT_KEY).toBeUndefined();
  });

  it('env: an unknown backend value is refused in config and ignored from the parent env', () => {
    expect(() => new BuyCliSource({ ...CFG, keystoreBackend: 'memory' as never })).toThrow(/keystoreBackend/);
    const d = execDouble('ok');
    const src = new BuyCliSource(CFG, d.exec, { ...parent, BUY_KEYSTORE_BACKEND: 'memory' });
    expect(Object.keys(src['env' as never] as object)).not.toContain('BUY_KEYSTORE_BACKEND');
  });

  it('source: the capability id grammar is the enclave grammar, checked against rules.rs', () => {
    const rules = readFileSync(new URL('../../../enclave/src/rules.rs', import.meta.url), 'utf8');
    expect(rules).toContain('b.is_ascii_alphanumeric() || b".:_/-".contains(&b)');
    for (const id of ['a', 'chainstack/celo-rpc', 'a.b_c:d/e-f', 'A9']) expect(CAPABILITY_ID.test(id), id).toBe(true);
    for (const id of ['', 'a b', 'a+b', 'a@b', 'a,b', "a'b", 'a"b', 'a\\b', 'a%b', 'a\n', 'é', 'a'.repeat(129)]) expect(CAPABILITY_ID.test(id), JSON.stringify(id)).toBe(false);
  });

  it('config: every required buy field is refused at parse time, never becoming buy:undefined', () => {
    const base = { network: 'mainnet', registry: '0x' + '1'.repeat(40), agentId: '1', origin: 'https://attessa.example.com', stateDir: '/tmp/s', gatewayDbPath: '/tmp/g.db' };
    const full = { capabilityId: 'x', url: 'https://buy.example.test/rpc', maxAmount: '0.01' };
    for (const k of ['capabilityId', 'url', 'maxAmount'] as const) {
      const { [k]: _gone, ...rest } = full;
      expect(() => parseConfig({ ...base, buy: rest }), k).toThrow(new RegExp(k));
      expect(() => parseConfig({ ...base, buy: { ...full, [k]: 5 } }), k).toThrow(new RegExp(k));
    }
    expect(() => parseConfig({ ...base, buy: { ...full, keystoreBackend: 'memory' } })).toThrow(/keystoreBackend/);
    expect(parseConfig({ ...base, buy: { ...full, keystoreBackend: 'file' } }).buy?.keystoreBackend).toBe('file');
  });

  it('guard: an unwritable state file falls back to Forno, logs the fault, and makes no paid call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-buy-'));
    writeFileSync(join(dir, 'file'), 'x');
    const guard = new BuySpendGuard(join(dir, 'file', 'sub', 'g.json'), { settledSince: () => 0n }); // ENOTDIR on save
    const d = execDouble('ok');
    const logs: string[] = [];
    const buy = new BuyCliSource(CFG, d.exec, {});
    const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy, guard, timeoutMs: 1000, log: (e) => logs.push(e) });
    expect((await f.fetch(PAY_TO, NOW)).source).toBe('forno');
    expect(d.seen).toHaveLength(0);
    expect(logs).toContain('buy_guard_fault');
  });

  it('guard: a trip that cannot be written to disk still falls back to Forno', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-buy-'));
    writeFileSync(join(dir, 'file'), 'x');
    const guard = new BuySpendGuard(join(dir, 'file', 'g.json'), { settledSince: () => 0n });
    const d = execDouble('ok');
    const buy = new BuyCliSource({ ...CFG, maxAmountAtomic: 100_000n }, d.exec, {});
    const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy, guard, timeoutMs: 1000, log: () => {} });
    // cost 0.1 USDC is within the 1 USDC budget, so allow() is true, but the first record() throws: no paid call.
    expect((await f.fetch(PAY_TO, NOW)).source).toBe('forno');
    expect(d.seen).toHaveLength(0);
  });

  it('abort: the process group is killed, so a curl grandchild cannot finish a payment after the timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-buy-'));
    const marker = join(dir, 'paid');
    const script = join(dir, 'buy');
    // The stand-in leaves a background child that would "finish the payment" 1.2 s later, with stdout closed.
    writeFileSync(script, `#!/bin/sh\n(sleep 1.2; echo done > "${marker}") >/dev/null 2>&1 &\nwait\n`);
    chmodSync(script, 0o755);
    const src = new BuyCliSource({ ...CFG, binary: script }, undefined, { PATH: '/usr/bin:/bin' });
    await expect(src.batch(calls, AbortSignal.timeout(250))).rejects.toThrow(/buy failed/);
    await new Promise((r) => setTimeout(r, 1700));
    expect(existsSync(marker)).toBe(false);
  });

  it('cross-check: a paid block with the right number and a wrong hash or timestamp is a failed buy read', async () => {
    for (const tamper of ['hash', 'timestamp'] as const) {
      const d = execDouble('ok');
      const exec: Exec = async (file, args, opts) => {
        const { stdout } = await d.exec(file, args, opts);
        const arr = JSON.parse(stdout) as Array<{ id: number; result: Record<string, string> }>;
        const blk = arr.find((r) => r.id === 1)!.result;
        if (tamper === 'hash') blk.hash = '0x' + 'ab'.repeat(32);
        else blk.timestamp = '0x1';
        return { stdout: JSON.stringify(arr) };
      };
      const logs: Array<[string, unknown]> = [];
      const guard = new BuySpendGuard(join(mkdtempSync(join(tmpdir(), 'attessa-buy-')), 'g.json'), { settledSince: () => 0n });
      const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy: new BuyCliSource(CFG, exec, {}), guard, timeoutMs: 1000, log: (e, x) => logs.push([e, x]) });
      const i = await f.fetch(PAY_TO, NOW);
      expect(i.source, tamper).toBe('forno');
      expect(i.block.hash).toBe(forno.blockHash(BigInt(i.block.number)));
      expect(JSON.stringify(logs)).toContain('differs from Forno');
    }
  });

  it('cross-check: an honest paid block is checked against Forno at the same number, and Forno failing then does not fail the read', async () => {
    const { f, guard } = fetcher('ok');
    const i = await f.fetch(PAY_TO, NOW);
    expect(i.source).toBe('buy:test-capability');
    expect(forno.requests).toHaveLength(2);
    expect((forno.requests[1] as Array<{ method: string; params: string[] }>)[0]).toMatchObject({ method: 'eth_getBlockByNumber', params: ['0x3e7', false] });
    expect(guard.state(NOW).spentAtomic).toBe('10000');
    // Forno answers the head, then dies for the cross-check: the paid read stands.
    const d = execDouble('ok');
    const logs: string[] = [];
    let n = 0;
    const flaky = new HttpRpcSource('forno', forno.url, (async (u: string, o: RequestInit) => (n++ === 0 ? fetch(u, o) : Promise.reject(new Error('down')))) as typeof fetch);
    const g2 = new BuySpendGuard(join(mkdtempSync(join(tmpdir(), 'attessa-buy-')), 'g.json'), { settledSince: () => 0n });
    const f2 = new InputFetcher({ forno: flaky, buy: new BuyCliSource(CFG, d.exec, {}), guard: g2, timeoutMs: 1000, log: (e) => logs.push(e) });
    expect((await f2.fetch(PAY_TO, NOW)).source).toBe('buy:test-capability');
    expect(logs).toContain('inputs_crosscheck_unavailable');
  });

  it('head: Forno down and buy up, the head is a second counted paid request and buy alone serves the evaluate', async () => {
    forno.mode = 'http500';
    const { f, seen, guard } = fetcher('ok');
    const i = await f.fetch(PAY_TO, NOW);
    expect(i.source).toBe('buy:test-capability');
    expect(seen).toHaveLength(2);
    expect(JSON.parse(seen[0]!.args[seen[0]!.args.indexOf('--data') + 1]!)).toMatchObject([{ method: 'eth_blockNumber' }]);
    expect(guard.state(NOW).spentAtomic).toBe('20000');
  });

  it('head: the extra paid head request stays inside the budget, and with the budget used up nothing is counted for a call not made', async () => {
    forno.mode = 'http500';
    // Budget 1 USDC: record 0.99, leaving room for exactly one 0.01 request. The head takes it; the batch is refused.
    const { f, seen, guard } = fetcher('ok');
    guard.record(990_000n, NOW);
    await expect(f.fetch(PAY_TO, NOW)).rejects.toThrow(/inputs_unavailable/);
    expect(seen).toHaveLength(1);
    expect(guard.state(NOW).spentAtomic).toBe('1000000');
  });

  it('head: when the paid call never happens (budget gone) nothing is counted', async () => {
    forno.mode = 'http500';
    const { f, seen, guard } = fetcher('ok');
    guard.record(995_000n, NOW);
    await expect(f.fetch(PAY_TO, NOW)).rejects.toThrow(/inputs_unavailable/);
    expect(seen).toHaveLength(0);
    expect(guard.state(NOW).spentAtomic).toBe('995000');
  });
});
