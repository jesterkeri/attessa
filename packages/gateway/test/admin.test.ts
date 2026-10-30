import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPORT_COLUMNS, exportRows, pause, resume, status } from '../src/admin.ts';
import { runGatewayCommand } from '../src/cli.ts';
import { HttpFacilitator } from '../src/facilitator.ts';
import { makeHarness, type Harness } from './fakes/harness.ts';

let h: Harness;
afterEach(async () => {
  delete process.env.FACILITATOR_API_KEY;
  await h?.close();
});

describe('attessa gateway pause | resume | status | export (SPEC §6.6, §6.4)', () => {
  it('pause makes the running gateway answer 503 gateway_paused; resume checks /supported with the key first', async () => {
    h = await makeHarness();
    const key = randomBytes(16).toString('hex'); // in-test value, not a credential
    h.fac.apiKey = key;
    pause(h.db);
    expect((await h.quote()).statusCode).toBe(503);
    const refused = await resume(h.db, new HttpFacilitator(h.fac.url, 'wrong'));
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('401');
    expect(h.db.isPaused()).toBe(true);
    const ok = await resume(h.db, new HttpFacilitator(h.fac.url, key));
    expect(ok.ok).toBe(true);
    expect(h.fac.supportedCalls).toBe(1);
    expect(h.db.isPaused()).toBe(false);
    expect((await h.quote()).statusCode).toBe(402);
  });

  it('status counts rows per state', async () => {
    h = await makeHarness();
    await h.call(await h.pay());
    h.seller.tamper = { error: 'bad_inputs' };
    await h.call(await h.pay());
    expect(status(h.db)).toEqual({ paused: false, states: { delivered: 1, exec_failed: 1 } });
  });

  it('export --format csv|jsonl has the SPEC columns', async () => {
    h = await makeHarness();
    const r = await h.call(await h.pay());
    const id = r.headers['x-request-id'] as string;
    const since = new Date((h.clock.t - 60) * 1000).toISOString();
    const csv = exportRows(h.db, since, 'csv').trim().split('\n');
    expect(csv[0]).toBe('request_id,payer,pay_to,asset,amount,settle_tx,state,proof_verified,created_at');
    const row = h.row(id)!;
    expect(csv[1]).toBe(
      [id, h.buyer, h.cfg.payTo, row.asset, '20000', row.settle_tx, 'delivered', 'true', new Date(row.created_at * 1000).toISOString()].join(','),
    );
    const jl = exportRows(h.db, since, 'jsonl').trim().split('\n').map((l) => JSON.parse(l));
    expect(Object.keys(jl[0])).toEqual([...EXPORT_COLUMNS]);
    expect(exportRows(h.db, new Date((h.clock.t + 60) * 1000).toISOString(), 'csv').trim().split('\n')).toHaveLength(1);
    // The payment payload and response never appear in an export.
    expect(exportRows(h.db, since, 'jsonl')).not.toContain('verdict');
  });

  it('runGatewayCommand reads the config file and the API key from env only', async () => {
    h = await makeHarness();
    const key = randomBytes(16).toString('hex');
    h.fac.apiKey = key;
    const cfgPath = join(dirname(h.cfg.dbPath), 'gateway.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        network: 'celo-sepolia',
        registry: h.cfg.registry,
        agentId: '7',
        origin: h.cfg.origin,
        payTo: h.cfg.payTo,
        sellerHostUrl: 'http://127.0.0.1:1',
        facilitatorUrl: h.fac.url,
        dbPath: h.cfg.dbPath,
      }),
    );
    const out: string[] = [];
    const err: string[] = [];
    const run = (...a: string[]) => runGatewayCommand([...a, '--config', cfgPath], (s) => out.push(s), (s) => err.push(s));
    expect(await run('pause')).toBe(0);
    expect(h.db.isPaused()).toBe(true);
    expect(await run('resume')).toBe(1);
    expect(err.join('')).toContain('Not resumed');
    process.env.FACILITATOR_API_KEY = key;
    expect(await run('resume')).toBe(0);
    expect(h.db.isPaused()).toBe(false);
    expect(await run('status')).toBe(0);
    expect(JSON.parse(out[out.length - 1]!)).toEqual({ paused: false, states: {} });
    expect(await run('export', '--since', '2026-01-01', '--format', 'csv')).toBe(0);
    expect(out[out.length - 1]).toBe('request_id,payer,pay_to,asset,amount,settle_tx,state,proof_verified,created_at\n');
    expect(await run('export')).toBe(2);
    expect(await runGatewayCommand(['pause', '--network', 'testnet'], (s) => out.push(s), (s) => err.push(s))).toBe(2);
    expect(out.join('') + err.join('')).not.toContain(key);
  });
});
