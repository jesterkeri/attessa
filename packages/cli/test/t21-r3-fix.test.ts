import { describe, expect, it } from 'vitest';
import { run } from '../src/index.ts';
import { world } from './harness.ts';

// T21 adversary r3 fixes beyond the adversary's own tests: every read skips the wallet, and an unexpected error never
// prints its own message (it could quote a key), in text or --json.

const NET = ['--network', 'local', '--rpc', 'http://127.0.0.1:1'];

describe('reads never load the wallet (FLOWS "Reading doesn\'t require a wallet")', () => {
  it('status --agent works with a malformed ATTESSA_PRIVATE_KEY', async () => {
    const w = world();
    w.env.ATTESSA_PRIVATE_KEY = '0x1234';
    expect(await w.cli('status', '--agent', '412', ...NET)).toBe(0);
    expect(w.out[0]).toBe('Agent 412');
    expect(w.err).toEqual([]);
  });

  it('status --agent works with a key above the curve order', async () => {
    const w = world();
    w.env.ATTESSA_PRIVATE_KEY = `0x${'f'.repeat(64)}`;
    expect(await w.cli('status', '--agent', '412', ...NET)).toBe(0);
    expect(w.out[0]).toBe('Agent 412');
  });
});

describe('owner key above the curve order: the fixed reason, text mode', () => {
  it('endpoint retire prints the fixed line and no part of the key', async () => {
    const w = world();
    const key = `0x${'f'.repeat(64)}`;
    w.env.ATTESSA_PRIVATE_KEY = key;
    expect(await w.cli('endpoint', 'retire', '--origin', 'https://risk.example', ...NET)).toBe(1);
    expect(w.err).toEqual(["Can't load the wallet from ATTESSA_PRIVATE_KEY: not a valid private key.", 'Set ATTESSA_PRIVATE_KEY to a 0x-prefixed 32-byte hex key, or pass --keystore <file>.']);
    const printed = [...w.out, ...w.err].join('\n');
    expect(printed).not.toContain(BigInt(key).toString());
    expect(printed).not.toContain(key.slice(2));
  });
});

describe('an unexpected error never prints its message', () => {
  const secret = `0x${'ab'.repeat(32)}`;
  const failing = () => {
    const w = world();
    const deps = w.deps();
    deps.rpc = () => {
      const e = new Error(`boom ${secret} ${BigInt(secret).toString()}`) as Error & { code: string };
      e.code = 'ESOMETHING';
      throw e;
    };
    return { w, deps };
  };

  it('text: exit 1 and a fixed line naming only the class and code', async () => {
    const { w, deps } = failing();
    expect(await run(['status', '--agent', '412', ...NET], deps)).toBe(1);
    expect(w.err).toEqual([
      "Unexpected error (Error, ESOMETHING). Its message isn't printed, because it could contain a key.",
      'Run the command again; if it fails the same way, report it at github.com/jesterkeri/attessa/issues with this line.',
    ]);
  });

  it('--json: exit 1 and the {ok:false} object, without the message', async () => {
    const { w, deps } = failing();
    expect(await run(['status', '--agent', '412', ...NET, '--json'], deps)).toBe(1);
    const j = JSON.parse(w.out.at(-1)!);
    expect(j).toMatchObject({ ok: false, error: 'unexpected' });
    expect(w.out.join('\n')).not.toContain(secret.slice(2));
    expect(w.out.join('\n')).not.toContain(BigInt(secret).toString());
  });
});
