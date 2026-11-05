import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { CallStore } from './db.ts';
import { HttpFacilitator } from './facilitator.ts';
import { exportRows, pause, resume, status } from './admin.ts';

/** Default config path per network on the host (SPEC §5 table: one gateway per network). */
export function defaultConfigPath(network: string): string {
  return `/etc/attessa/gateway-${network}.config.json`;
}

const USAGE = 'usage: attessa gateway pause|resume|status|export [--network mainnet|sepolia] [--config <path>] [--dry-run]';
/**
 * `attessa gateway pause|resume|status|export [--network mainnet|sepolia] [--config <path>]`.
 * Returns the exit code; writes to the given streams. The API key is read from env `FACILITATOR_API_KEY` only.
 */
export async function runGatewayCommand(
  args: string[],
  out: (s: string) => void = (s) => process.stdout.write(s),
  err: (s: string) => void = (s) => process.stderr.write(s),
): Promise<number> {
  // Read as the rest of the CLI reads flags (node:util parseArgs): `--x v` or `--x=v`, the last one wins, and an
  // unknown flag is refused rather than ignored.
  let v: { network?: string; config?: string; since?: string; format?: string; 'dry-run'?: boolean };
  let pos: string[];
  try {
    ({ values: v, positionals: pos } = parseArgs({
      args,
      allowPositionals: true,
      options: { network: { type: 'string' }, config: { type: 'string' }, since: { type: 'string' }, format: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    }));
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const [cmd, ...extra] = pos;
  if (extra.length > 0) {
    err(`${USAGE}\n`);
    return 2;
  }
  const network = v.network ?? 'sepolia';
  if (network !== 'mainnet' && network !== 'sepolia') {
    err('--network must be mainnet or sepolia\n');
    return 2;
  }
  const path = v.config ?? defaultConfigPath(network);
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(path);
  } catch (e) {
    // Only the error code: the file's text is not echoed.
    err(`Can't read the ${network} gateway config at ${path} (${(e as { code?: string }).code ?? 'invalid'}).\nNext: check the file on this host, or pass --config <path>.\n`);
    return 1;
  }
  if (v['dry-run'] && (cmd === 'pause' || cmd === 'resume')) {
    out(`Would ${cmd} the ${network} gateway (${path}). Dry run: nothing was changed.\n`);
    return 0;
  }
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
        const since = v.since;
        const format = v.format ?? 'csv';
        if (!since || (format !== 'csv' && format !== 'jsonl')) {
          err('usage: attessa gateway export --since <date> --format csv|jsonl\n');
          return 2;
        }
        if (Number.isNaN(Date.parse(since))) {
          err(`--since must be a date, like 2026-11-01, not ${JSON.stringify(since)}.\nNext: attessa gateway export --since 2026-11-01 --format ${format}\n`);
          return 2;
        }
        out(exportRows(db, since, format));
        return 0;
      }
      default:
        err(`${USAGE}\n`);
        return 2;
    }
  } finally {
    db.close();
  }
}
