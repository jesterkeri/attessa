import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallStore } from '../../gateway/src/db.ts';
import { world, type World } from './harness.ts';

// Adversary T21 r63: `attessa gateway pause|resume|status|export [--network]` (SPEC.md:688) after the r62 fix.
// SPEC.md:653: "Global flags: `--network sepolia|mainnet|local`, `--rpc`, `--json`, `--yes`, `--dry-run`."
// runGatewayCommand now reads its flags with a strict parseArgs that knows network, config, since, format and
// dry-run only, so the global `--yes` and `--json` are "Unknown option" (exit 2). Before r62 they were ignored.
// Every other write tells the operator "add --yes to send without asking" (r60), so a kill-switch runbook line
// `attessa gateway pause --yes` is refused and the gateway keeps taking calls; `attessa gateway status --json`
// (FLOWS.md:438 "JSON mode (`--json`) for agents") exits 2 with no status.
//
// Same rig as r61/r62: loadConfig maps each /etc/attessa/gateway-{network}.config.json to its own CallStore file.

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
  const dir = mkdtempSync(join(tmpdir(), 'attessa-adv63-'));
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

describe('attessa gateway passthrough: SPEC.md:653 global flags (T21 adversary r63)', () => {
  it('control: `attessa gateway pause --network mainnet` pauses mainnet', async () => {
    const { runGatewayCommand } = await import('../../gateway/src/cli.ts');
    const { run } = await import('../src/index.ts');
    const code = await run(['gateway', 'pause', '--network', 'mainnet'], { ...w.deps(), gateway: runGatewayCommand });
    expect({ code, mainnet: paused('mainnet') }).toEqual({ code: 0, mainnet: true });
  });

  it('`attessa gateway pause --network mainnet --yes` pauses the mainnet gateway', async () => {
    const { runGatewayCommand } = await import('../../gateway/src/cli.ts');
    const { run } = await import('../src/index.ts');
    const code = await run(['gateway', 'pause', '--network', 'mainnet', '--yes'], { ...w.deps(), gateway: runGatewayCommand });
    expect({ code, mainnet: paused('mainnet'), err: w.err }).toEqual({ code: 0, mainnet: true, err: w.err });
  });

  it('`attessa gateway status --json` prints the status', async () => {
    const { runGatewayCommand } = await import('../../gateway/src/cli.ts');
    const { run } = await import('../src/index.ts');
    const code = await run(['gateway', 'status', '--json'], { ...w.deps(), gateway: runGatewayCommand });
    expect({ code, status: w.out.some((l) => l.includes('"paused":false')), err: w.err }).toEqual({ code: 0, status: true, err: w.err });
  });
});
