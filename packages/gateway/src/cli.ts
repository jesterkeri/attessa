import { loadConfig } from './config.ts';
import { CallStore } from './db.ts';
import { HttpFacilitator } from './facilitator.ts';
import { exportRows, pause, resume, status } from './admin.ts';

/** Default config path per network on the host (SPEC §5 table: one gateway per network). */
export function defaultConfigPath(network: string): string {
  return `/etc/attessa/gateway-${network}.config.json`;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * `attessa gateway pause|resume|status|export [--network mainnet|sepolia] [--config <path>]`.
 * Returns the exit code; writes to the given streams. The API key is read from env `FACILITATOR_API_KEY` only.
 */
export async function runGatewayCommand(
  args: string[],
  out: (s: string) => void = (s) => process.stdout.write(s),
  err: (s: string) => void = (s) => process.stderr.write(s),
): Promise<number> {
  const [cmd, ...rest] = args;
  const network = flag(rest, '--network') ?? 'sepolia';
  if (network !== 'mainnet' && network !== 'sepolia') {
    err('--network must be mainnet or sepolia\n');
    return 2;
  }
  const cfg = loadConfig(flag(rest, '--config') ?? defaultConfigPath(network));
  const db = new CallStore(cfg.dbPath);
  try {
    switch (cmd) {
      case 'pause':
        out(`${pause(db)}\n`);
        return 0;
      case 'resume': {
        const f = new HttpFacilitator(cfg.facilitatorUrl, process.env.FACILITATOR_API_KEY, cfg.facilitatorAuthHeader, cfg.facilitatorAuthPrefix);
        const r = await resume(db, f);
        (r.ok ? out : err)(`${r.message}\n`);
        return r.ok ? 0 : 1;
      }
      case 'status':
        out(`${JSON.stringify(status(db))}\n`);
        return 0;
      case 'export': {
        const since = flag(rest, '--since');
        const format = flag(rest, '--format') ?? 'csv';
        if (!since || (format !== 'csv' && format !== 'jsonl')) {
          err('usage: attessa gateway export --since <date> --format csv|jsonl\n');
          return 2;
        }
        out(exportRows(db, since, format));
        return 0;
      }
      default:
        err('usage: attessa gateway pause|resume|status|export [--network mainnet|sepolia] [--config <path>]\n');
        return 2;
    }
  } finally {
    db.close();
  }
}
