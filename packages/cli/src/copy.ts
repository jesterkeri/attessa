/**
 * User-facing lines, verbatim from FLOWS.md §6 (J3 dialog) and §8 (errors), with only their `{…}` slots
 * filled. Lines FLOWS doesn't have are marked `// not in FLOWS` and listed as design questions.
 */

/** `0x7f3b…22`: the short form FLOWS uses for addresses, hashes and tx ids. */
export function short(h: string): string {
  return h.length <= 10 ? h : `${h.slice(0, 6)}…${h.slice(-2)}`;
}

/** "about 0.03 CELO" / "about 8 CELO". */
export function celo(wei: bigint): string {
  const v = Number(wei) / 1e18;
  if (v >= 1) return String(Math.max(1, Math.round(v)));
  const c = Math.max(0.01, Math.round(v * 100) / 100);
  return c.toFixed(2);
}

/** "Oct 26 14:00 UTC". */
export function utcShort(sec: bigint | number): string {
  const d = new Date(Number(sec) * 1000);
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${d.getUTCDate()} ${hh}:${mm} UTC`;
}

/** `https://risk.example` → `risk.example`. */
export function host(origin: string): string {
  return origin.replace(/^https?:\/\//, '');
}

/** `https://github.com/acme/risk/commit/a1b2c3d…` → `acme/risk @ a1b2c3d`; anything else as given. */
export function sourceLabel(sourceRef: string): string {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:commit|tree)\/([0-9a-f]{7,40})\/?$/i.exec(sourceRef);
  return m ? `${m[1]}/${m[2]} @ ${m[3]!.slice(0, 7)}` : sourceRef;
}

export const COPY = {
  // §6 J3
  sellerHelp: [
    'Sell an API that buyers can check before paying: you approve a build of your code, run it in a sealed AWS machine, and register that machine\'s key on Celo.',
    '  Steps: agent register → enclave build → release approve → endpoint add → enclave start → signer register',
  ],
  built: (eif: string, src: string) => `Built ${eif} from ${src}. Measurements written to build/measurements.json.  Next: attessa release approve.`,
  approveIntro: (src: string, agent: string, rid: string) =>
    `Approving the build made from ${src} for agent ${agent}  (release ${short(rid)}; PCR0-2 read from the build output)`,
  approvePrompt: (src: string, cost: string) =>
    `  Buyers will see "owner says it's built from ${src}" (attessa can't check that claim). One transaction, about ${cost} CELO.  [approve/cancel]`,
  approved: (tx: string) => `Approved (tx ${short(tx)}). Next: attessa endpoint add.`,
  endpointPrompt: (h: string, payTo: string, agent: string, cost: string) =>
    `Buyers of ${h} will pay ${short(payTo)} and only accept answers from agent ${agent}'s approved builds. One transaction, about ${cost} CELO.  [add/cancel]`,
  endpointAdded: (tx: string) => `Added (tx ${short(tx)}).`,
  starting: (eif: string) => `Starting the sealed machine from ${eif}… running (Nitro enclave, 1 vCPU, 1 GiB)`,
  started: (file: string) =>
    `It made a fresh signing key and AWS signed a report of what's running  (attestation written to ${file}; register within 30 minutes, or get a fresh one any time with --fresh)`,
  registerPrompt: (cached: number, total: number, txs: number, cost: string, maxCost: string) =>
    `This publishes the machine's key on Celo so buyers can check it. Up to ${total + 1} transactions, about ${maxCost} CELO at today's price (${cached} of ${total} certificates already cached, so ${txs} transactions, about ${cost} CELO).  [register/cancel]`,
  certCached: (i: number, n: number, tx: string) => `[${i}/${n}] Certificate cached  (tx ${short(tx)})`,
  signerLive: (i: number, n: number, signer: string, h: string, agent: string, tx: string) =>
    `[${i}/${n}] Signer ${short(signer)} is live for ${h}, running agent ${agent}'s approved build  (tx ${short(tx)})`,
  validUntil: (until: string) =>
    `Valid until ${until}, or until the machine restarts. To renew without a restart: attessa signer renew. After a restart (new key): attessa enclave start, then attessa signer register (about 4–6 CELO, up to 8 if no certificates are cached).`,
  livenessOk: 'Liveness check passed. Buyers can check this seller now.',
  // not in FLOWS: the renew dialog has no sample lines.
  renewPrompt: (signer: string, cached: number, total: number, txs: number, cost: string) =>
    `This renews signer ${short(signer)} for 7 days with a fresh report from the same machine (${cached} of ${total} certificates already cached, so ${txs} transactions, about ${cost} CELO).  [renew/cancel]`,
  renewed: (i: number, n: number, signer: string, until: string, tx: string) =>
    `[${i}/${n}] Signer ${short(signer)} renewed, valid until ${until}  (tx ${short(tx)})`,
} as const;

/** One refusal or error: what happened, then the one next action (FLOWS §8 columns), and its machine code. */
export class CliError extends Error {
  readonly code: string;
  readonly next: string | null;
  constructor(code: string, message: string, next: string | null = null) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.next = next;
  }
}

export const ERR = {
  // §6 J3 repair paths
  attestationStale: (min: number) =>
    new CliError(
      'attestation_stale',
      `Not registered: the machine's report is ${min} minutes old and Celo accepts 30. Run \`attessa signer register --fresh\` to get a new report from the same machine (no restart).`,
    ),
  wrongBuild: (agent: string, rid: string) =>
    new CliError(
      'release_not_approved',
      `Not registered: this machine runs a build agent ${agent} hasn't approved (release ${short(rid)}). Approve it with \`attessa release approve\`, or start the approved build.`,
    ),
  debugMode: () =>
    new CliError('debug_pcrs', "Not registered: the machine was started in debug mode, which AWS doesn't sign for. Start it without --debug-mode."),
  // §8
  bindingMismatch: (what: string, field: string) =>
    new CliError(`binding_mismatch{${field}}`, `Not registered: the attestation was made for ${what}.`, 'Re-attest with the right agent and origin in the config.'),
  certExpired: () =>
    new CliError(
      'cert_expired',
      'The certificate chain in this attestation has expired.',
      'Run `attessa signer register --fresh` (a fresh report carries current certificates).',
    ),
  notOwner: (agent: string, owner: string, signer: string) =>
    new CliError(
      'not_owner',
      `Only agent ${agent}'s owner (${owner}) can do this; this command was signed by ${signer}.`,
      'Run it from the owner wallet (--keystore or ATTESSA_PRIVATE_KEY).',
    ),
  originTaken: (origin: string, b: string) =>
    new CliError('origin_taken', `${origin} is already registered to agent ${b}.`, `Use a different origin or ask agent ${b}'s owner to retire it.`),
  networkMismatch: (x: number, y: number) =>
    new CliError('network_mismatch', `Your RPC is on chain ${x}; this registry is on ${y}.`, `Set \`--rpc\` for ${y}.`),
  rpcUnavailable: (rpc: string) => new CliError('rpc_unavailable', `Can't reach Celo at ${rpc}. Nothing was signed.`, 'Retry or set another `--rpc`.'),
  invalidOrigin: () => new CliError('invalid_origin', 'Use just the scheme and host, like https://risk.example (no path, lowercase).'),
  invalidBuildFile: (file: string) =>
    new CliError(
      'invalid_pcr',
      `Couldn't read the build measurements in ${file}. It should be the JSON that \`nitro-cli build-enclave\` prints.`,
      'Pass the file nitro-cli wrote.',
    ),
  releaseExists: (agent: string, rid: string) => new CliError('release_exists', `This build is already approved for agent ${agent} (release ${short(rid)}).`),
  endpointInactive: (origin: string, agent: string) =>
    new CliError('endpoint_inactive', `Not registered: ${origin} isn't an active endpoint for agent ${agent}.`, 'Add it with `attessa endpoint add`.'),
  notOperator: (address: string, origin: string) =>
    new CliError('not_operator', `Not registered: ${address} isn't the operator for ${origin}.`, 'Run from the operator wallet set in `attessa endpoint add`.'),
  renewRefused: (code: string, reason: string, expired: boolean) =>
    new CliError(
      code,
      `Not renewed: ${reason}.`,
      expired ? 'Restart with `attessa enclave start`, then `attessa signer register`.' : 'Run `attessa signer renew` on the machine that holds this key.',
    ),
  nsmUnavailable: () =>
    new CliError(
      'nsm_unavailable',
      "The sealed machine couldn't get a signed report from AWS (no /dev/nsm). Is this a Nitro-enabled instance?",
      'Use an instance type with enclaves enabled, like c6g.xlarge with --enclave-options Enabled=true.',
    ),
  gasTooLow: (step: string) => new CliError('gas_too_low', `The transaction ran out of gas at ${step}. Nothing changed.`, 'Run again; the CLI re-estimates.'),
  // not in FLOWS
  noRegistry: (network: string) =>
    new CliError('no_registry', `No EnclaveRegistry address is known for ${network}.`, 'Set ATTESSA_REGISTRY to the registry address.'),
  signerExists: (signer: string) =>
    new CliError('signer_exists', `Not registered: signer ${short(signer)} is already registered.`, 'To extend it without a restart: attessa signer renew.'),
  usage: (msg: string) => new CliError('usage', msg),
} as const;

/**
 * `signer renew` refusals for the checks it shares with registration: FLOWS §8 "R: renew refused" with the
 * register rows' reason words. // not in FLOWS: that row names none of these codes.
 */
export const RENEW = {
  debugMode: () => ERR.renewRefused('debug_pcrs', "the machine was started in debug mode, which AWS doesn't sign for", false),
  wrongBuild: (agent: string, rid: string) =>
    ERR.renewRefused('release_not_approved', `this machine runs a build agent ${agent} hasn't approved (release ${short(rid)})`, false),
  bindingMismatch: (what: string, field: string) => ERR.renewRefused(`binding_mismatch{${field}}`, `the attestation was made for ${what}`, false),
} as const;
