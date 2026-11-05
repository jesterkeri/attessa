import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { CallStore } from './db.ts';
import { HttpFacilitator } from './facilitator.ts';
import { exportRecords, exportRows, pause, resume, resumeCheck, status } from './admin.ts';

/** Default config path per network on the host (SPEC §5 table: one gateway per network). */
export function defaultConfigPath(network: string): string {
  return `/etc/attessa/gateway-${network}.config.json`;
}

const USAGE = 'usage: attessa gateway pause|resume|status|export [--network mainnet|sepolia] [--config <path>] [--dry-run] [--json]';
/**
 * `attessa gateway pause|resume|status|export [--network mainnet|sepolia] [--config <path>]`.
 * Returns the exit code; writes to the given streams. The API key is read from env `FACILITATOR_API_KEY` only.
 *
 * The SPEC §8 global flags are accepted: `--yes` and `--rpc` change nothing (these commands never ask and never read
 * a chain), and under `--json` every outcome is one JSON object on stdout (`ok`, and `message`/`next` or the status),
 * as the rest of the CLI prints it; `export --json` is `{ok, rows}` with one object per row (the `--format` columns).
 */
export async function runGatewayCommand(
  args: string[],
  out: (s: string) => void = (s) => process.stdout.write(s),
  err: (s: string) => void = (s) => process.stderr.write(s),
): Promise<number> {
  // Until the flags parse, a literal --json decides how a usage error is printed.
  let json = args.includes('--json');
  const done = (code: number, fields: Record<string, unknown>): number => {
    out(`${JSON.stringify({ ok: code === 0, ...fields })}\n`);
    return code;
  };
  const say = (message: string): number => (json ? done(0, { message }) : (out(`${message}\n`), 0));
  // Every refusal names one next action (FLOWS.md:832); a usage refusal's is the usage line's own form.
  const fail = (code: number, error: string, message: string, next = 'Next: run it again in the form the usage line shows.'): number =>
    json ? done(code, { error, message, next }) : (err(`${message}\n${next}\n`), code);

  // Read as the rest of the CLI reads flags (node:util parseArgs): `--x v` or `--x=v`, the last one wins, and an
  // unknown flag is refused rather than ignored.
  let v: { network?: string; config?: string; since?: string; format?: string; 'dry-run'?: boolean; json?: boolean };
  let pos: string[];
  try {
    ({ values: v, positionals: pos } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        network: { type: 'string' },
        config: { type: 'string' },
        since: { type: 'string' },
        format: { type: 'string' },
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
        yes: { type: 'boolean' },
        rpc: { type: 'string' },
      },
    }));
  } catch (e) {
    return fail(2, 'usage', (e as Error).message, USAGE);
  }
  json = v.json === true;
  const [cmd, ...extra] = pos;
  if (extra.length > 0 || !['pause', 'resume', 'status', 'export'].includes(cmd ?? '')) return fail(2, 'usage', USAGE);
  const network = v.network ?? 'sepolia';
  if (network !== 'mainnet' && network !== 'sepolia') return fail(2, 'usage', '--network must be mainnet or sepolia', USAGE);
  const path = v.config ?? defaultConfigPath(network);
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(path);
  } catch (e) {
    // Only the error code: the file's text is not echoed.
    return fail(
      1,
      'config_unreadable',
      `Can't read the ${network} gateway config at ${path} (${(e as { code?: string }).code ?? 'invalid'}).`,
      'Next: check the file on this host, or pass --config <path>.',
    );
  }
  const dryRun = v['dry-run'] === true;
  const resumeNext = `Next: check FACILITATOR_API_KEY in this shell and the facilitator credit, then run attessa gateway resume --network ${network} again.`;
  if (dryRun && cmd === 'pause') return say(`Would pause the ${network} gateway (${path}). Dry run: nothing was changed.`);
  if (cmd === 'resume') {
    const f = new HttpFacilitator(cfg.facilitatorUrl, process.env.FACILITATOR_API_KEY, cfg.facilitatorAuthHeader, cfg.facilitatorAuthPrefix);
    if (dryRun) {
      // The same /supported check the real resume makes, so the preview can't promise a resume it would refuse.
      const refused = await resumeCheck(f);
      return refused ? fail(1, 'not_resumed', refused, resumeNext) : say(`Would resume the ${network} gateway (${path}). Dry run: nothing was changed.`);
    }
    const db = new CallStore(cfg.dbPath);
    try {
      const r = await resume(db, f);
      return r.ok ? say(r.message) : fail(1, 'not_resumed', r.message, resumeNext);
    } finally {
      db.close();
    }
  }
  if (cmd === 'export') {
    const since = v.since;
    const format = v.format ?? 'csv';
    if (!since || (format !== 'csv' && format !== 'jsonl')) return fail(2, 'usage', 'usage: attessa gateway export --since <date> --format csv|jsonl');
    if (Number.isNaN(Date.parse(since))) {
      return fail(2, 'usage', `--since must be a date, like 2026-11-01, not ${JSON.stringify(since)}.`, `Next: attessa gateway export --since 2026-11-01 --format ${format}`);
    }
  }
  const db = new CallStore(cfg.dbPath);
  try {
    switch (cmd) {
      case 'pause':
        return say(pause(db));
      case 'status':
        if (json) return done(0, status(db));
        out(`${JSON.stringify(status(db))}\n`);
        return 0;
      default:
        if (json) return done(0, { rows: exportRecords(db, v.since!) });
        out(exportRows(db, v.since!, (v.format ?? 'csv') as 'csv' | 'jsonl'));
        return 0;
    }
  } finally {
    db.close();
  }
}
