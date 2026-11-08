import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuyCliSource } from '../src/buy.ts';
import { parseConfig } from '../src/config.ts';
import { BuySpendGuard } from '../src/guard.ts';
import { HttpRpcSource, InputFetcher } from '../src/inputs.ts';
import { FakeRpc } from './fake-rpc.ts';

// Adversary probes for T28 (commit 312ce7b). Test doubles only: no real buy, wallet or payment.
const PAY_TO = '0x2222222222222222222222222222222222222222';
const CALLS = [{ method: 'eth_blockNumber', params: [] as unknown[] }];
const CFG = { capabilityId: 'test-capability', url: 'https://buy.example.test/rpc', maxAmountAtomic: 10_000n };

describe('T28 adversary', () => {
  it('abort: the 5 s timeout holds when buy has spawned a curl child that keeps stdout open', async () => {
    // @celo/buy 0.8.5 dist/commands/probe.js runCurl: spawn('curl', args, { stdio: ['pipe'|'inherit', 'inherit', ...] }),
    // so curl is a grandchild of seller-host and holds the same stdout pipe. The stand-in below does the same.
    const dir = mkdtempSync(join(tmpdir(), 'attessa-adv-'));
    const pidFile = join(dir, 'curl.pid');
    const script = join(dir, 'buy');
    writeFileSync(script, `#!/bin/sh\nsleep 25 &\necho $! > "${pidFile}"\nwait\n`);
    chmodSync(script, 0o755);
    const src = new BuyCliSource({ ...CFG, binary: script });
    const t0 = Date.now();
    try {
      await src.batch(CALLS, AbortSignal.timeout(300)).catch(() => {});
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  it('env: buy keeps its key in the file backend on a headless host, so BUY_KEYSTORE_BACKEND must reach the child', async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const exec = async (_f: string, _a: string[], o: { env: NodeJS.ProcessEnv }) => {
      seen.push(o.env);
      return { stdout: '[]' };
    };
    const src = new BuyCliSource(CFG, exec as never, { PATH: '/bin', HOME: '/h', BUY_KEYSTORE_BACKEND: 'file', AGENT_PRIVATE_KEY: 'S' });
    await src.batch(CALLS, AbortSignal.timeout(1000)).catch(() => {});
    expect(seen[0]).toBeDefined();
    expect(seen[0]!.BUY_KEYSTORE_BACKEND).toBe('file');
    expect(seen[0]!.AGENT_PRIVATE_KEY).toBeUndefined();
  });

  it('source: a capability id the enclave would refuse (bad_inputs) is refused at config time', () => {
    // enclave/src/rules.rs is_source: buy:<id>, id = [A-Za-z0-9._:/-]+
    for (const id of ['chainstack+celo', 'a@b', 'a,b', "a'b", 'a\\b', 'a"b', 'a%b', 'a$b']) {
      expect(() => new BuyCliSource({ ...CFG, capabilityId: id }), id).toThrow();
    }
  });

  it('source: a buy block without capabilityId does not become source "buy:undefined"', () => {
    const base = { network: 'mainnet', registry: '0x' + '1'.repeat(40), agentId: '1', origin: 'https://attessa.example.com', stateDir: '/tmp/s', gatewayDbPath: '/tmp/g.db' };
    expect(() => parseConfig({ ...base, buy: { url: 'https://buy.example.test/rpc', maxAmount: '0.01' } })).toThrow();
  });
});

describe('T28 adversary: guard failure must not fail the evaluate', () => {
  let forno: FakeRpc;
  beforeEach(async () => {
    forno = new FakeRpc();
    await forno.start();
    forno.accounts.set(PAY_TO, { code: '0x6001', nonce: 1n, balance: 5n });
  });
  afterEach(async () => {
    await forno.stop();
  });
  it('an unwritable guard state falls back to Forno instead of failing the evaluate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attessa-adv-'));
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    const guard = new BuySpendGuard(join(blocker, 'sub', 'g.json'), { settledSince: () => 0n }); // mkdir fails: ENOTDIR
    const exec = async () => ({ stdout: '[]' });
    const buy = new BuyCliSource(CFG, exec as never, {});
    const f = new InputFetcher({ forno: new HttpRpcSource('forno', forno.url), buy, guard, timeoutMs: 1000 });
    expect((await f.fetch(PAY_TO, new Date('2026-11-10T12:00:00Z'))).source).toBe('forno');
  });
});
