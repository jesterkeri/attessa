import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';

// T21 adversary r25.
// `attessa init` writes config.json with a plain writeFile (bin.ts: writeFileSync, which truncates and then writes),
// so a write cut short (a full disk, as adversary-t21-r24 simulates, or the process killed mid-write) leaves a
// truncated config.json. Every buyer command then stops with "<path> isn't valid JSON. Run attessa init again."
// (buyer.ts readConfig), and `attessa init` is one of them: run() reads the config for every buyer command before
// dispatch (index.ts BUYER), and init() reads it again. So the row's one next action can never succeed, and the buyer
// is stuck until they find and delete the file by hand. FLOWS §8: every error row has exactly one next action.
// The truncated file is init's own output cut in half.

let home = '';
let key = generatePrivateKey();
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function deps(): { d: Deps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const d: Deps = {
    io: { out: (l) => void out.push(l), err: (l) => void err.push(l), confirm: async () => true },
    env: { ATTESSA_PRIVATE_KEY: key },
    cwd: home,
    home,
    keychain: null,
    rpc: () => {
      throw new Error('init reads no chain');
    },
    runner: { run: async () => ({ code: 1, stdout: '', stderr: 'no runner' }) },
    fetch,
    enclave: () => {
      throw new Error('no enclave');
    },
    readFile: (p) => readFileSync(p),
    writeFile: (p, data) => writeFileSync(p, data),
    exists: (p) => existsSync(p),
    readdir: (p) => readdirSync(p),
    sleep: async () => {},
    arch: 'x64',
  };
  return { d, out, err };
}

describe('T21 adversary r25: a config.json cut short by an interrupted init', () => {
  it('the row says "Run attessa init again.", so attessa init must get past the broken file', async () => {
    home = mkdtempSync(join(tmpdir(), 'attessa-r25-'));
    key = generatePrivateKey();
    expect(await run(['init'], deps().d)).toBe(0);
    const cfg = join(home, '.attessa', 'config.json');
    expect(JSON.parse(readFileSync(cfg, 'utf8')).network).toBe('sepolia');

    // The state a write cut short leaves (writeFileSync truncates first): the first half of init's own output.
    const text = readFileSync(cfg, 'utf8');
    writeFileSync(cfg, text.slice(0, Math.floor(text.length / 2)));
    expect(() => JSON.parse(readFileSync(cfg, 'utf8'))).toThrow();

    // Every buyer command now names one next action: run init again.
    const a = deps();
    expect(await run(['evidence', 'export'], a.d)).toBe(1);
    expect(a.err.join('\n')).toContain("isn't valid JSON. Run attessa init again.");

    // Following that next action has to work.
    const b = deps();
    const code = await run(['init'], b.d);
    expect(b.err).toEqual([]);
    expect(code).toBe(0);
  });
});
