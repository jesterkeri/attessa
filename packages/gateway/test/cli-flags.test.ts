import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGatewayCommand } from '../src/cli.ts';
import { makeHarness, type Harness } from './fakes/harness.ts';

// SPEC §8: "Global flags: `--network sepolia|mainnet|local`, `--rpc`, `--json`, `--yes`, `--dry-run`." The gateway
// operator commands are part of the same CLI, so they take the global flags (T21 adversary r63), and
// `resume --dry-run` makes the same /supported check the real resume makes (SPEC §6.6).

let h: Harness;
afterEach(async () => {
  delete process.env.FACILITATOR_API_KEY;
  await h?.close();
});

async function rig() {
  h = await makeHarness();
  const key = randomBytes(16).toString('hex'); // in-test value, not a credential
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
  return { key, cfgPath, out, err, run };
}

describe('attessa gateway: SPEC §8 global flags', () => {
  it('--yes and --rpc are accepted and change nothing', async () => {
    const { run, err } = await rig();
    expect(await run('pause', '--yes', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    expect(h.db.isPaused()).toBe(true);
    expect(err).toEqual([]);
  });

  it('--json: each outcome is one JSON object on stdout, errors included, and the key never appears', async () => {
    const { run, out, err, key } = await rig();
    expect(await run('pause', '--json')).toBe(0);
    expect(JSON.parse(out.pop()!)).toEqual({ ok: true, message: 'Gateway paused: new calls get 503 gateway_paused; open payments keep reconciling.' });
    expect(await run('status', '--json')).toBe(0);
    expect(JSON.parse(out.pop()!)).toEqual({ ok: true, paused: true, states: {} });
    expect(await run('resume', '--json')).toBe(1);
    const refused = JSON.parse(out.pop()!);
    expect(refused).toMatchObject({ ok: false, error: 'not_resumed' });
    expect(refused.message).toContain('Not resumed');
    expect(h.db.isPaused()).toBe(true);
    process.env.FACILITATOR_API_KEY = key;
    expect(await run('resume', '--json')).toBe(0);
    expect(JSON.parse(out.pop()!)).toEqual({ ok: true, message: 'Gateway resumed.' });
    expect(await run('export', '--json', '--since', 'yesterday')).toBe(2);
    expect(JSON.parse(out.pop()!)).toEqual({
      ok: false,
      error: 'usage',
      message: '--since must be a date, like 2026-11-01, not "yesterday".',
      next: 'Next: attessa gateway export --since 2026-11-01 --format csv',
    });
    expect(await run('pause', '--json', '--bogus')).toBe(2);
    expect(JSON.parse(out.pop()!)).toMatchObject({ ok: false, error: 'usage' });
    expect(err).toEqual([]);
    expect(out.join('')).not.toContain(key);
  });

  it('--json given as the value of another flag does not switch JSON on', async () => {
    const { run, out } = await rig();
    expect(await run('export', '--since', '2026-01-01', '--format', 'csv', '--rpc=--json')).toBe(0);
    expect(out.pop()).toBe('request_id,payer,pay_to,asset,amount,settle_tx,state,proof_verified,created_at\n');
  });

  it('a config that cannot be read is a JSON error under --json, with its next action', async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await runGatewayCommand(['status', '--json', '--config', '/nonexistent/attessa-gw.json'], (s) => out.push(s), (s) => err.push(s))).toBe(1);
    expect(JSON.parse(out.pop()!)).toEqual({
      ok: false,
      error: 'config_unreadable',
      message: "Can't read the sepolia gateway config at /nonexistent/attessa-gw.json (ENOENT).",
      next: 'Next: check the file on this host, or pass --config <path>.',
    });
    expect(err).toEqual([]);
  });
});

describe('attessa gateway resume --dry-run (SPEC §6.6)', () => {
  it('a refused API key: the preview refuses as resume would, and nothing changes', async () => {
    const { run, err, out } = await rig();
    expect(await run('pause')).toBe(0);
    process.env.FACILITATOR_API_KEY = 'wrong';
    expect(await run('resume', '--dry-run')).toBe(1);
    expect(err.join('')).toContain('Not resumed: the facilitator refused the API key or credit (HTTP 401).');
    expect(out.join('')).not.toContain('Would resume');
    expect(h.db.isPaused()).toBe(true);
  });

  it('a working API key: the preview says it would resume, checks /supported once, and leaves the gateway paused', async () => {
    const { run, out, key } = await rig();
    expect(await run('pause')).toBe(0);
    process.env.FACILITATOR_API_KEY = key;
    expect(await run('resume', '--dry-run')).toBe(0);
    expect(out.pop()).toMatch(/^Would resume the sepolia gateway \(.*gateway\.config\.json\)\. Dry run: nothing was changed\.\n$/);
    expect(h.fac.supportedCalls).toBe(1);
    expect(h.db.isPaused()).toBe(true);
  });
});
