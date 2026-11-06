import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallStore } from '../../gateway/src/db.ts';
import { world, type World } from './harness.ts';

// Adversary T21 r62: `attessa gateway pause|resume|status|export [--network]` (SPEC.md:562, :688) after the r61 fix.
// The gateway's `flag()` (packages/gateway/src/cli.ts) says it reads flags "as parseArgs reads the rest of the CLI".
// It does not for a repeated flag: parseArgs (every other attessa command, SPEC.md:653 global `--network`) takes the
// last value, `flag()` takes the first. So `attessa gateway pause --network sepolia --network mainnet` pauses the
// Sepolia gateway, prints "Gateway paused: ..." and exits 0, while mainnet keeps taking calls.
//
// Second: a gateway command that fails on its input ends "Unexpected error (Error). Its message isn't printed ..."
// with no next action (FLOWS.md:832 "Every error row has one next action"); `export --since yesterday` is one.
//
// Same rig as r61: loadConfig maps each /etc/attessa/gateway-{network}.config.json to its own real CallStore file.

const dbs: Record<string, string> = {};
vi.mock('../../gateway/src/config.ts', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    loadConfig: (path: string) => {
      const net = /gateway-(mainnet|sepolia)\.config\.json$/.exec(path)?.[1];
      if (!net) throw new Error(`no test config at ${path}`);
      return { dbPath: dbs[net] };
    },
  };
});

let w: World;
beforeEach(() => {
  w = world();
  const dir = mkdtempSync(join(tmpdir(), 'attessa-adv62-'));
  dbs.mainnet = join(dir, 'mainnet.sqlite');
  dbs.sepolia = join(dir, 'sepolia.sqlite');
  for (const p of Object.values(dbs)) new CallStore(p).close();
});

function paused(net: 'mainnet' | 'sepolia'): boolean {
  const db = new CallStore(dbs[net]!);
  try {
    return db.isPaused();
  } finally {
    db.close();
  }
}

describe('attessa gateway passthrough: repeated --network (T21 adversary r62)', () => {
  it('control: the rest of the CLI (parseArgs) takes the last of two --network values', async () => {
    const { parseArgs } = await import('node:util');
    const { values } = parseArgs({ args: ['--network', 'sepolia', '--network', 'mainnet'], options: { network: { type: 'string' } } });
    expect(values.network).toBe('mainnet');
  });

  it('`attessa gateway pause --network sepolia --network mainnet` pauses mainnet (last wins) or refuses; never Sepolia', async () => {
    const { runGatewayCommand } = await import('../../gateway/src/cli.ts');
    const { run } = await import('../src/index.ts');
    const code = await run(['gateway', 'pause', '--network', 'sepolia', '--network', 'mainnet'], { ...w.deps(), gateway: runGatewayCommand });
    expect({ sepolia: paused('sepolia'), mainnetOrRefused: paused('mainnet') || code !== 0, code, out: w.out }).toEqual({
      sepolia: false,
      mainnetOrRefused: true,
      code,
      out: w.out,
    });
  });
});

describe('attessa gateway passthrough: --dry-run (T21 adversary r62)', () => {
  // SPEC.md:653 lists --dry-run as a global flag; FLOWS.md:846 "Preview replaces undo. `--dry-run` on every write".
  it('`attessa gateway pause --dry-run` leaves the gateway taking calls', async () => {
    const { runGatewayCommand } = await import('../../gateway/src/cli.ts');
    const { run } = await import('../src/index.ts');
    const code = await run(['gateway', 'pause', '--dry-run'], { ...w.deps(), gateway: runGatewayCommand });
    expect({ sepolia: paused('sepolia'), code, out: w.out }).toEqual({ sepolia: false, code, out: w.out });
  });
});

describe('attessa gateway: an input error ends with one next action (T21 adversary r62)', () => {
  it('`attessa gateway export --since yesterday --format csv` names a next action', async () => {
    const { runGatewayCommand } = await import('../../gateway/src/cli.ts');
    const { run } = await import('../src/index.ts');
    const code = await run(['gateway', 'export', '--since', 'yesterday', '--format', 'csv'], { ...w.deps(), gateway: runGatewayCommand });
    expect(code).not.toBe(0);
    // The row must say something the operator can act on: a message and a next action, not only the generic
    // "Unexpected error" line that hides what was wrong.
    const lines = w.err.join('\n').split('\n').filter((l) => l.trim() !== '');
    expect({ twoOrMore: lines.length >= 2, generic: lines.some((l) => l.startsWith('Unexpected error')), err: w.err }).toEqual({
      twoOrMore: true,
      generic: false,
      err: w.err,
    });
  });
});
