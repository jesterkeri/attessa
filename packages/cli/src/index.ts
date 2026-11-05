import { parseArgs } from 'node:util';
import { AttestError } from '@attessa/sdk';
import { enclaveBuild, enclaveStart } from './commands/enclave.ts';
import { call, cancel, dataDir, display, evidenceExport, fromSdk, init, readConfig, readConfigForInit, status } from './commands/buyer.ts';
import { endpointAdd, releaseApprove } from './commands/owner.ts';
import {
  agentRegister,
  agentSetWallet,
  agentStatus,
  agentTransfer,
  agentWalletSig,
  endpointRetire,
  releaseStatus,
  revokeSigner,
  selflink,
} from './commands/registry.ts';
import { signerRegister, signerRenew } from './commands/signer.ts';
import type { Deps, Global, NetworkFlag } from './context.ts';
import { COPY, CliError, diskError, jsonOut, unexpected } from './copy.ts';

export * from './context.ts';
export * from './copy.ts';
export { parseAttestation, hintPlan } from './attestation.ts';

const GLOBAL = {
  network: { type: 'string' },
  rpc: { type: 'string' },
  json: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} as const;

type Opts = Record<string, { type: 'string' | 'boolean'; default?: boolean }>;

/** Each command: its flags, and how many positional arguments follow its words. */
const COMMANDS: Record<string, { opts: Opts; args: number }> = {
  // buyer
  init: { opts: { 'max-amount': { type: 'string' }, 'daily-cap': { type: 'string' }, keystore: { type: 'string' } }, args: 0 },
  call: {
    opts: {
      body: { type: 'string' },
      'max-amount': { type: 'string' },
      asset: { type: 'string' },
      new: { type: 'boolean', default: false },
      'no-wait': { type: 'boolean', default: false },
      out: { type: 'string' },
      keystore: { type: 'string' },
    },
    args: 1,
  },
  cancel: { opts: { keystore: { type: 'string' } }, args: 1 },
  status: { opts: { agent: { type: 'string' }, pending: { type: 'boolean', default: false }, keystore: { type: 'string' } }, args: 1 },
  'evidence export': { opts: { format: { type: 'string' } }, args: 0 },
  // owner
  'agent register': { opts: { name: { type: 'string' }, description: { type: 'string' }, uri: { type: 'string' } }, args: 0 },
  'agent transfer': { opts: { agent: { type: 'string' }, to: { type: 'string' } }, args: 0 },
  'agent wallet-sig': { opts: { agent: { type: 'string' }, owner: { type: 'string' }, deadline: { type: 'string' } }, args: 0 },
  'agent set-wallet': { opts: { agent: { type: 'string' }, wallet: { type: 'string' }, sig: { type: 'string' }, deadline: { type: 'string' } }, args: 0 },
  selflink: { opts: { agent: { type: 'string' }, 'self-agent': { type: 'string' } }, args: 0 },
  'release approve': { opts: { agent: { type: 'string' }, 'from-build': { type: 'string' }, source: { type: 'string' } }, args: 0 },
  'release deprecate': { opts: { agent: { type: 'string' } }, args: 1 },
  'release revoke': { opts: { agent: { type: 'string' } }, args: 1 },
  'revoke release': { opts: { agent: { type: 'string' } }, args: 1 },
  'revoke signer': { opts: {}, args: 1 },
  'endpoint add': { opts: { agent: { type: 'string' }, origin: { type: 'string' }, 'pay-to': { type: 'string' }, operator: { type: 'string' } }, args: 0 },
  'endpoint retire': { opts: { origin: { type: 'string' } }, args: 0 },
  // operator
  'enclave build': { opts: { name: { type: 'string' } }, args: 0 },
  'enclave start': {
    opts: {
      agent: { type: 'string' },
      origin: { type: 'string' },
      port: { type: 'string' },
      'test-build': { type: 'boolean', default: false },
      eif: { type: 'string' },
      out: { type: 'string' },
    },
    args: 0,
  },
  'signer register': {
    opts: {
      agent: { type: 'string' },
      attestation: { type: 'string' },
      fresh: { type: 'boolean', default: false },
      origin: { type: 'string' },
      'seller-host': { type: 'string' },
    },
    args: 0,
  },
  'signer renew': { opts: { attestation: { type: 'string' }, 'seller-host': { type: 'string' } }, args: 0 },
};

/** Buyer commands read the network from `attessa init`'s config when --network is absent (FLOWS J0). */
const BUYER = new Set(['init', 'call', 'cancel', 'status', 'evidence export']);

const BOOLEAN_FLAGS = new Set(['json', 'yes', 'dry-run', 'help', 'test-build', 'fresh', 'new', 'no-wait', 'pending']);

type Values = Record<string, string | boolean | undefined>;

function str(v: Values, k: string): string | undefined {
  const x = v[k];
  return typeof x === 'string' ? x : undefined;
}

/** `attessa <words…> [args…] [flags]`. Returns the exit code; all output goes through `deps.io`. */
export async function run(argv: string[], deps: Deps): Promise<number> {
  // Command words are the positionals: tokens that aren't flags or the value of a string flag.
  const takesValue = (flag: string) => flag.startsWith('--') && !flag.includes('=') && !BOOLEAN_FLAGS.has(flag.slice(2));
  const positional = argv.filter((a, i) => !a.startsWith('-') && (i === 0 || !takesValue(argv[i - 1]!)));
  const two = positional.slice(0, 2).join(' ');
  const key = COMMANDS[two] ? two : (positional[0] ?? '');
  const lines: string[] = [];
  const data: Record<string, unknown> = {};
  let json = argv.includes('--json');
  let told = 0; // FLOWS:833: a confirm names its consequence first, so under --json the held lines go to stderr before it
  const confirm = async (yesWord: string): Promise<boolean> => {
    for (; told < lines.length; told++) deps.io.err(lines[told]!);
    return deps.io.confirm(yesWord);
  };
  const io = json ? { ...deps.io, confirm, out: (l: string) => lines.push(l), data: (f: Record<string, unknown>) => void Object.assign(data, f) } : deps.io;
  const d: Deps = { ...deps, io };
  let g: Global | undefined;
  try {
    if (positional[0] === 'gateway') {
      // SPEC §8 gateway operator commands are @attessa/gateway's own (T19); they take their flags as given.
      if (!deps.gateway) throw new CliError('usage', 'attessa gateway is only available where @attessa/gateway is installed.');
      const at = argv.indexOf('gateway');
      const rest = [...argv.slice(0, at), ...argv.slice(at + 1)];
      return await deps.gateway(rest, (s) => s.split('\n').filter((l, i, all) => l !== '' || i < all.length - 1).forEach((l) => deps.io.out(l)), (s) => deps.io.err(s.replace(/\n$/, '')));
    }
    if (positional[0] === 'seller' || positional.length === 0) {
      for (const l of COPY.sellerHelp) io.out(l);
      return finish(0);
    }
    const spec = COMMANDS[key];
    if (!spec) throw new CliError('usage', `Unknown command: attessa ${two}. Try: attessa seller --help`);
    const { values, positionals } = parseArgs({ args: argv, options: { ...GLOBAL, ...spec.opts }, allowPositionals: true, strict: true });
    const words = key.split(' ').length;
    const args = positionals.slice(words);
    if (args.length > spec.args) throw new CliError('usage', `Unexpected argument: ${args.slice(spec.args).join(' ')}`);
    const v = values as Values;
    json = v.json === true;
    const flagNetwork = str(v, 'network') as NetworkFlag | undefined;
    const cfg = key === 'init' ? readConfigForInit(d) : BUYER.has(key) ? readConfig(d) : null;
    const network = flagNetwork ?? cfg?.network ?? 'sepolia';
    if (!['sepolia', 'mainnet', 'local'].includes(network)) throw new CliError('usage', '--network must be sepolia, mainnet or local.');
    g = { network, rpc: str(v, 'rpc'), json, yes: v.yes === true, dryRun: v['dry-run'] === true };
    const a0 = args[0];
    switch (key) {
      case 'init':
        return finish(await init(g, d, { networkFlag: flagNetwork !== undefined, maxAmount: str(v, 'max-amount'), dailyCap: str(v, 'daily-cap'), keystore: str(v, 'keystore') }));
      case 'call':
        return finish(
          await call(
            g,
            d,
            {
              url: a0,
              body: str(v, 'body'),
              maxAmount: str(v, 'max-amount'),
              asset: str(v, 'asset'),
              newRequest: v.new === true,
              noWait: v['no-wait'] === true,
              out: str(v, 'out'),
              keystore: str(v, 'keystore'),
            },
            cfg,
          ),
        );
      case 'cancel':
        return finish(await cancel(g, d, { id: a0, keystore: str(v, 'keystore') }));
      case 'status':
        if (str(v, 'agent') !== undefined) {
          if (a0 !== undefined || v.pending === true) throw new CliError('usage', 'Use either attessa status <origin> [--pending] or attessa status --agent <id>.');
          return finish(await agentStatus(g, d, { agent: str(v, 'agent') }));
        }
        return finish(await status(g, d, { target: a0, pending: v.pending === true, keystore: str(v, 'keystore') }));
      case 'evidence export':
        return finish(await evidenceExport(g, d, { format: str(v, 'format') }));
      case 'agent register':
        return finish(await agentRegister(g, d, { name: str(v, 'name'), description: str(v, 'description'), uri: str(v, 'uri') }));
      case 'agent transfer':
        return finish(await agentTransfer(g, d, { agent: str(v, 'agent'), to: str(v, 'to') }));
      case 'agent wallet-sig':
        return finish(await agentWalletSig(g, d, { agent: str(v, 'agent'), owner: str(v, 'owner'), deadline: str(v, 'deadline') }));
      case 'agent set-wallet':
        return finish(await agentSetWallet(g, d, { agent: str(v, 'agent'), wallet: str(v, 'wallet'), sig: str(v, 'sig'), deadline: str(v, 'deadline') }));
      case 'selflink':
        return finish(await selflink(g, d, { agent: str(v, 'agent'), selfAgent: str(v, 'self-agent') }));
      case 'release deprecate':
        return finish(await releaseStatus(g, d, { id: a0, agent: str(v, 'agent'), to: 'deprecate' }));
      case 'release revoke':
      case 'revoke release':
        return finish(await releaseStatus(g, d, { id: a0, agent: str(v, 'agent'), to: 'revoke' }));
      case 'revoke signer':
        return finish(await revokeSigner(g, d, { signer: a0 }));
      case 'endpoint retire':
        return finish(await endpointRetire(g, d, { origin: str(v, 'origin') }));
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
          : // An SDK refusal code missed by a command still gets its FLOWS row (an AttestError is raised before anything is
            // signed); anything else is said without its raw message (it could carry a key), and --json gets its error object.
            ((g && e instanceof AttestError ? fromSdk(g, e) : null) ?? (BUYER.has(key) ? diskError(e, display(deps, dataDir(deps))) : null) ?? unexpected(e));
    if (json) {
      deps.io.out(jsonOut({ ok: false, error: err.code, message: err.message, next: err.next, lines, ...data }));
    } else {
      io.err(err.message);
      if (err.next) io.err(err.next);
    }
    return 1;
  }

  function finish(code: number): number {
    if (json) deps.io.out(jsonOut({ ...data, ok: code === 0, lines }));
    return code;
  }
}
