import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallStore } from '../../gateway/src/db.ts';
import { world, type World } from './harness.ts';

// Adversary T21 r61: `attessa gateway pause|resume|status|export [--network]` (SPEC.md:688) is handed to
// @attessa/gateway's runGatewayCommand "with its flags as given" (index.ts gateway branch). Every other attessa command
// reads its flags with node:util parseArgs, which takes `--network=mainnet` as well as `--network mainnet` (SPEC.md:653
// lists --network as a global flag). The gateway's own flag reader only matches the separate form, so
// `attessa gateway pause --network=mainnet` falls back to sepolia: it pauses the Sepolia gateway, prints
// "Gateway paused: ..." and exits 0, while the mainnet gateway keeps taking calls.
//
// The two gateway configs live at /etc/attessa/gateway-{network}.config.json on the host (gateway cli.ts
// defaultConfigPath). Here loadConfig is replaced by one that maps each of those two paths to its own real CallStore
// file in a temp dir, so the test reads the real paused flag of each network's database after the command.

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
  const dir = mkdtempSync(join(tmpdir(), 'attessa-adv61-'));
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

describe('attessa gateway passthrough: --network=<name> (T21 adversary r61)', () => {
  it('control: `attessa gateway pause --network mainnet` pauses the mainnet gateway only', async () => {
    const { runGatewayCommand } = await import('../../gateway/src/cli.ts');
    const { run } = await import('../src/index.ts');
    const code = await run(['gateway', 'pause', '--network', 'mainnet'], { ...w.deps(), gateway: runGatewayCommand });
    expect(code).toBe(0);
    expect({ mainnet: paused('mainnet'), sepolia: paused('sepolia') }).toEqual({ mainnet: true, sepolia: false });
  });

  it('`attessa gateway pause --network=mainnet` pauses the mainnet gateway, not Sepolia (or refuses)', async () => {
    const { runGatewayCommand } = await import('../../gateway/src/cli.ts');
    const { run } = await import('../src/index.ts');
    const code = await run(['gateway', 'pause', '--network=mainnet'], { ...w.deps(), gateway: runGatewayCommand });
    // Either outcome is acceptable: the mainnet gateway paused, or a refusal that changed nothing. Never Sepolia.
    expect({ sepolia: paused('sepolia'), mainnetOrRefused: paused('mainnet') || code !== 0, out: w.out }).toEqual({
      sepolia: false,
      mainnetOrRefused: true,
      out: w.out,
    });
  });
});
