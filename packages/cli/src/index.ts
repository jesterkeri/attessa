import { parseArgs } from 'node:util';
import { enclaveBuild, enclaveStart } from './commands/enclave.ts';
import { endpointAdd, releaseApprove } from './commands/owner.ts';
import { signerRegister, signerRenew } from './commands/signer.ts';
import type { Deps, Global, NetworkFlag } from './context.ts';
import { COPY, CliError } from './copy.ts';

export * from './context.ts';
export * from './copy.ts';
export { parseAttestation, hintPlan } from './attestation.ts';

const GLOBAL = {
  network: { type: 'string', default: 'sepolia' },
  rpc: { type: 'string' },
  json: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} as const;

const COMMANDS = {
  'enclave build': { name: { type: 'string' } },
  'enclave start': {
    agent: { type: 'string' },
    origin: { type: 'string' },
    port: { type: 'string' },
    'test-build': { type: 'boolean', default: false },
    eif: { type: 'string' },
    out: { type: 'string' },
  },
  'release approve': { agent: { type: 'string' }, 'from-build': { type: 'string' }, source: { type: 'string' } },
  'endpoint add': { agent: { type: 'string' }, origin: { type: 'string' }, 'pay-to': { type: 'string' }, operator: { type: 'string' } },
  'signer register': {
    agent: { type: 'string' },
    attestation: { type: 'string' },
    fresh: { type: 'boolean', default: false },
    origin: { type: 'string' },
    'seller-host': { type: 'string' },
  },
  'signer renew': { attestation: { type: 'string' }, 'seller-host': { type: 'string' } },
} as const;

const BOOLEAN_FLAGS = new Set(['json', 'yes', 'dry-run', 'help', 'test-build', 'fresh']);

type Values = Record<string, string | boolean | undefined>;

function str(v: Values, k: string): string | undefined {
  const x = v[k];
  return typeof x === 'string' ? x : undefined;
}

/** `attessa <words…> [flags]`. Returns the exit code; all output goes through `deps.io`. */
export async function run(argv: string[], deps: Deps): Promise<number> {
  // Command words are the positionals: tokens that aren't flags or the value of a string flag.
  const takesValue = (flag: string) => flag.startsWith('--') && !flag.includes('=') && !BOOLEAN_FLAGS.has(flag.slice(2));
  const words = argv.filter((a, i) => !a.startsWith('-') && (i === 0 || !takesValue(argv[i - 1]!))).slice(0, 2);
  const key = words.join(' ');
  const lines: string[] = [];
  let json = argv.includes('--json');
  const io = json ? { ...deps.io, out: (l: string) => lines.push(l) } : deps.io;
  const d: Deps = { ...deps, io };
  try {
    if (words[0] === 'seller' || words.length === 0) {
      for (const l of COPY.sellerHelp) io.out(l);
      return finish(0);
    }
    const spec = COMMANDS[key as keyof typeof COMMANDS];
    if (!spec) throw new CliError('usage', `Unknown command: attessa ${key}. Try: attessa seller --help`);
    const { values, positionals } = parseArgs({ args: argv, options: { ...GLOBAL, ...spec }, allowPositionals: true, strict: true });
    if (positionals.length !== 2) throw new CliError('usage', `Unexpected argument: ${positionals.slice(2).join(' ')}`);
    const v = values as Values;
    json = v.json === true;
    const network = str(v, 'network') as NetworkFlag;
    if (!['sepolia', 'mainnet', 'local'].includes(network)) throw new CliError('usage', '--network must be sepolia, mainnet or local.');
    const g: Global = { network, rpc: str(v, 'rpc'), json, yes: v.yes === true, dryRun: v['dry-run'] === true };
    switch (key) {
      case 'enclave build':
        return finish(await enclaveBuild(g, d, { ...(str(v, 'name') ? { name: str(v, 'name')! } : {}) }));
      case 'enclave start':
        return finish(
          await enclaveStart(g, d, {
            agent: str(v, 'agent'),
            origin: str(v, 'origin'),
            port: str(v, 'port'),
            testBuild: v['test-build'] === true,
            eif: str(v, 'eif'),
            out: str(v, 'out'),
          } as never),
        );
      case 'release approve':
        return finish(await releaseApprove(g, d, { agent: str(v, 'agent'), fromBuild: str(v, 'from-build'), source: str(v, 'source') } as never));
      case 'endpoint add':
        return finish(await endpointAdd(g, d, { agent: str(v, 'agent'), origin: str(v, 'origin'), payTo: str(v, 'pay-to'), operator: str(v, 'operator') } as never));
      case 'signer register':
        return finish(
          await signerRegister(g, d, {
            agent: str(v, 'agent'),
            attestation: str(v, 'attestation'),
            fresh: v.fresh === true,
            origin: str(v, 'origin'),
            sellerHost: str(v, 'seller-host'),
          } as never),
        );
      case 'signer renew':
        return finish(await signerRenew(g, d, { attestation: str(v, 'attestation'), sellerHost: str(v, 'seller-host') } as never));
    }
    return finish(1);
  } catch (e) {
    const err =
      e instanceof CliError
        ? e
        : e instanceof TypeError && (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
          ? new CliError('usage', e.message)
          : null;
    if (!err) throw e;
    if (json) {
      deps.io.out(JSON.stringify({ ok: false, error: err.code, message: err.message, next: err.next, lines }));
    } else {
      io.err(err.message);
      if (err.next) io.err(err.next);
    }
    return 1;
  }

  function finish(code: number): number {
    if (json) deps.io.out(JSON.stringify({ ok: code === 0, lines }));
    return code;
  }
}
