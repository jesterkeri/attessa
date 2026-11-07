import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGatewayCommand } from '../src/cli.ts';
import { makeHarness, type Harness } from './fakes/harness.ts';

// FLOWS.md §9 "Recovery": "Every error row has one next action". SPEC §6.6 / SPEC.md:562: `resume` first calls the
// facilitator `/supported` with the API key and refuses if it gets 401/402. The refusal is an error row (exit 1,
// `--json` `error: "not_resumed"`), so it must say what to do next, as config_unreadable and a bad --since do.
// The most common way to hit it on the host: FACILITATOR_API_KEY is not set in the operator's shell.

let h: Harness;
afterEach(async () => {
  delete process.env.FACILITATOR_API_KEY;
  await h?.close();
});

async function rig() {
  h = await makeHarness();
  h.fac.apiKey = 'adversary-r64-in-test-value'; // in-test value, not a credential
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
  return { out, err, run };
}

describe('attessa gateway resume refused: the error row has one next action (FLOWS §9 Recovery)', () => {
  it('--json: a refused /supported (no API key set) carries a next action', async () => {
    const { run, out } = await rig();
    expect(await run('pause')).toBe(0);
    delete process.env.FACILITATOR_API_KEY;
    expect(await run('resume', '--json')).toBe(1);
    const refused = JSON.parse(out.pop()!);
    expect(refused).toMatchObject({ ok: false, error: 'not_resumed' });
    expect(h.db.isPaused()).toBe(true);
    expect(typeof refused.next).toBe('string');
    expect((refused.next as string).length).toBeGreaterThan(0);
  });

  it('text: the refusal prints a next-action line after the "Not resumed" line', async () => {
    const { run, err } = await rig();
    expect(await run('pause')).toBe(0);
    delete process.env.FACILITATOR_API_KEY;
    expect(await run('resume')).toBe(1);
    const lines = err.join('').split('\n').filter((l) => l !== '');
    expect(lines[0]).toBe('Not resumed: the facilitator refused the API key or credit (HTTP 401).');
    expect(lines.length).toBe(2);
  });

  it('resume --dry-run refused the same way also carries a next action', async () => {
    const { run, out } = await rig();
    expect(await run('pause')).toBe(0);
    process.env.FACILITATOR_API_KEY = 'wrong';
    expect(await run('resume', '--dry-run', '--json')).toBe(1);
    const refused = JSON.parse(out.pop()!);
    expect(refused).toMatchObject({ ok: false, error: 'not_resumed' });
    expect(typeof refused.next).toBe('string');
  });
});
