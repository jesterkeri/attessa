import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuyCliSource, MAX_AMOUNT_CEILING_ATOMIC, atomicToDecimal, type Exec } from '../src/buy.ts';
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
