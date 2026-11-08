import { DEPLOYMENTS } from '@attessa/core';

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

/** An upper bound in CELO, rounded up: "0.62" below 1 CELO (hundredths), "13" from 1 CELO (whole). */
export function celoUp(wei: bigint): string {
  const ceil = (unit: bigint) => (wei + unit - 1n) / unit;
  const cents = ceil(10n ** 16n);
  if (cents >= 100n) return String(ceil(10n ** 18n));
  return `0.${String(cents).padStart(2, '0')}`;
}

/** "Oct 26 14:00 UTC". */
export function utcShort(sec: bigint | number): string {
  const d = new Date(Number(sec) * 1000);
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${d.getUTCDate()} ${hh}:${mm} UTC`;
}

/**
 * Seller- or chain-supplied text (an on-chain sourceRef, a gateway's `detail`) rendered for a terminal: C0 and C1
 * controls and DEL become `\xNN`, and line/paragraph separators and Unicode's Bidi_Control set (U+061C, U+200E,
 * U+200F, U+202A to U+202E, U+2066 to U+2069) become `\u{NNNN}`, so a `\r`, an ANSI escape or a direction override
 * can't overwrite or hide the text around it, e.g. "(not checked by attessa)" (KNOWN-LIMITS L20). Printable text,
 * FLOWS' included, comes back unchanged.
 */
export function safe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (ch) => {
    const n = ch.charCodeAt(0);
    return n <= 0xff ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u{${n.toString(16)}}`;
  });
}

/** JSON for a terminal: the C1, separator and Bidi_Control characters `safe()` names become `\uNNNN` (JSON.stringify already escapes C0), lossless. */
export function jsonOut(v: unknown): string {
  return JSON.stringify(v).replace(/[\x7f-\x9f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Own-property lookup, so a `detail` of "constructor" or "__proto__" isn't found on Object.prototype. */
export function checkWords(detail: string | undefined): [string, string] | undefined {
  return detail !== undefined && Object.hasOwn(CHECK_WORDS, detail) ? CHECK_WORDS[detail] : undefined;
}

/** `https://risk.example` → `risk.example`. */
export function host(origin: string): string {
  return origin.replace(/^https?:\/\//, '');
}

/**
 * `https://github.com/acme/risk/commit/a1b2c3d…` → `acme/risk @ a1b2c3d`; anything else as given. Escaped on every
 * path: a GitHub-shaped ref is still the owner's unchecked text (KNOWN-LIMITS L20).
 */
export function sourceLabel(sourceRef: string): string {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:commit|tree)\/([0-9a-f]{7,40})\/?$/i.exec(sourceRef);
  return safe(m ? `${m[1]}/${m[2]} @ ${m[3]!.slice(0, 7)}` : withoutCredentials(sourceRef));
}

/**
 * A URL the CLI is about to publish on Celo (a release's `--source`, an agent's `--uri`): anything published stays
 * public for good, so a user name, password, query or fragment is refused before anything is encoded or signed.
 */
export function refuseSecretUrl(value: string | undefined, flag: string): void {
  if (value === undefined) return;
  let u: URL | null;
  try {
    u = new URL(value);
  } catch {
    u = null;
  }
  // Text that is not a URL is refused for `//user@`, `?` or `#` too: it is published as given.
  const secret = u ? u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' : /\/\/[^/@\s]*@|[?#]/.test(value);
  if (secret) {
    throw new CliError(
      'secret_in_url', // not in FLOWS
      `${flag} would be published on Celo for good, and it has a user name, password, query or fragment in it. Nothing was signed.`,
      `Pass ${flag} with only its scheme, host and path.`,
    );
  }
}

/**
 * A URL-like text as it may be printed: a parsable URL keeps scheme, host and path but loses its userinfo, query
 * and fragment (where tokens ride); free text loses anything shaped like `//user:secret@` or `?…`/`#…`.
 */
export function withoutCredentials(text: string): string {
  try {
    const u = new URL(text);
    if (u.host) return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    // not a URL: fall through to the text rules
  }
  return text.replace(/\/\/[^/@\s]*@/g, '//').replace(/[?#].*$/s, '');
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
/**
 * An RPC URL as it may be printed: scheme, host and port only. Provider keys ride in the userinfo, the path
 * (`/v3/<key>`), the query or the fragment, so none of those is ever shown. Anything that isn't a URL is shown as
 * "your RPC", except the fixed label "your --rpc".
 */
export function rpcShownSafe(rpc: string, fallback = 'your RPC'): string {
  if (rpc === 'your --rpc') return rpc;
  try {
    const u = new URL(rpc);
    return /^(https?|wss?):$/.test(u.protocol) && u.host ? `${u.protocol}//${u.host}` : fallback;
  } catch {
    return fallback;
  }
}

/** The next action an error gets when its row names none (FLOWS.md:832: every error row has one). */
const FALLBACK_NEXT: Record<string, string> = {
  usage: 'Run `attessa seller --help` for the commands and their flags.',
  reverted: 'Check the arguments and the wallet with `attessa status --agent <id>`, then run it again.',
  bad_key: 'Set ATTESSA_PRIVATE_KEY to a 0x-prefixed 32-byte hex key, or pass --keystore <file>.',
  invalid_pcr: 'Fetch a fresh report with `attessa signer register --fresh`.',
  unexpected: 'Run the command again; if it fails the same way, report it at github.com/jesterkeri/attessa/issues with this line.',
};
const LAST_NEXT = 'Run `attessa seller --help` for the commands and their flags.';

export class CliError extends Error {
  readonly code: string;
  readonly next: string | null;
  /** The FLOWS line already says its next action (FLOWS §6 J1/J3, §8 "(the example is the action)"): `next` names it for
   * --json, and text mode doesn't print it a second time. */
  readonly inline: boolean;
  constructor(code: string, message: string, next: string | null = null, inline = false) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    // Never null: a row without its own next action takes the code's fallback (FLOWS.md:832).
    this.next = next ?? FALLBACK_NEXT[code] ?? LAST_NEXT;
    this.inline = inline;
  }
}

/**
 * An error the CLI didn't expect, said without its message: a library's text can quote its input, and the input may
 * be a key (viem prints a key above the curve order in decimal; SPEC §7 "Never printed"). Only the error's class
 * name and a Node-style code get out, and only when they look like identifiers. // not in FLOWS
 */
/** The binary's last resort for a rejection that escapes run(): the fixed line and its next action, never the raw message. */
export function lastResortLines(e: unknown): string {
  const err = unexpected(e);
  return `${err.message}\n${err.next && !err.inline ? `${err.next}\n` : ''}`;
}

export function unexpected(e: unknown): CliError {
  const name = e instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? e.name : 'Error';
  const raw = (e as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(raw) ? `, ${raw}` : '';
  return new CliError('unexpected', `Unexpected error (${name}${code}). Its message isn't printed, because it could contain a key.`);
}

const SQLITE_DISK: Record<number, string> = { 8: 'SQLITE_READONLY', 10: 'SQLITE_IOERR', 13: 'SQLITE_FULL', 14: 'SQLITE_CANTOPEN' };
const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EFBIG', 'EACCES', 'EPERM', 'EROFS', 'EIO', ...Object.values(SQLITE_DISK)]);

/**
 * A buyer command's file write that failed mid-call (full disk, permissions): the pending ledger may hold a signed or
 * paid call, so the one next action is the command that finishes it. // not in FLOWS
 */
export function diskError(e: unknown, dir: string): CliError | null {
  // The SDK's ledger wraps SQLite's error and keeps it as `cause`: look one level down too.
  const cause = (e as { cause?: unknown } | null)?.cause;
  if (cause && cause !== e) {
    const inner = diskError(cause, dir);
    if (inner) return inner;
  }
  const err = e as { code?: unknown; errcode?: unknown } | null;
  // node:sqlite (the ledger's lock file) reports SQLite's own result code; its low byte is the primary code.
  const code = err?.code === 'ERR_SQLITE_ERROR' && typeof err.errcode === 'number' ? SQLITE_DISK[err.errcode & 0xff] : err?.code;
  if (typeof code !== 'string' || !DISK_CODES.has(code)) return null;
  return new CliError(
    'disk_write_failed',
    `Couldn't write a file attessa keeps on this computer (${code}).`,
    `Free up space in ${dir}, or make it writable, then run \`attessa status --pending\` to finish any call in progress.`,
  );
}

export const ERR = {
  /** A write's confirm answered anything but its verb (or stdin isn't a terminal). Not in FLOWS: OPEN-QUESTIONS r60. */
  cancelled: (verb: string) =>
    new CliError('not_confirmed', 'Cancelled: nothing was sent.', `Run it again and type ${verb}, or add --yes to send without asking.`),
  // §6 J3 repair paths
  attestationStale: (min: number) =>
    new CliError(
      'attestation_stale',
      `Not registered: the machine's report is ${min} minutes old and Celo accepts 30. Run \`attessa signer register --fresh\` to get a new report from the same machine (no restart).`,
      'Run `attessa signer register --fresh` (same machine, no restart).',
      true,
    ),
  wrongBuild: (agent: string, rid: string) =>
    new CliError(
      'release_not_approved',
      `Not registered: this machine runs a build agent ${agent} hasn't approved (release ${short(rid)}). Approve it with \`attessa release approve\`, or start the approved build.`,
      'Approve it with `attessa release approve`, or start the approved build.',
      true,
    ),
  debugMode: () =>
    new CliError(
      'debug_pcrs',
      "Not registered: the machine was started in debug mode, which AWS doesn't sign for. Start it without --debug-mode.",
      'Restart without --debug-mode.',
      true,
    ),
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
  rpcUnavailable: (rpc: string) => new CliError('rpc_unavailable', `Can't reach Celo at ${rpcShownSafe(rpc)}. Nothing was signed.`, 'Retry or set another `--rpc`.'),
  /**
   * A transaction was signed and may have been broadcast, then the RPC dropped (the broadcast's reply, or the
   * receipt poll): it may still land, so never "Nothing was sent". The full hash, so it can be looked up.
   * // not in FLOWS: §8 has no row for a sent transaction whose outcome a dropped RPC hides.
   */
  sentUnconfirmed: (what: string, hash: string, next: string) =>
    new CliError('tx_unconfirmed', `Lost the connection to Celo after sending ${what} (tx ${hash}); it may still land.`, next),
  invalidOrigin: () =>
    new CliError('invalid_origin', 'Use just the scheme and host, like https://risk.example (no path, lowercase).', 'Use just the scheme and host, like https://risk.example.', true),
  invalidBuildFile: (file: string) =>
    new CliError(
      'invalid_pcr',
      `Couldn't read the build measurements in ${file}. It should be the JSON that \`nitro-cli build-enclave\` prints.`,
      'Pass the file nitro-cli wrote.',
    ),
  releaseExists: (agent: string, rid: string) =>
    new CliError('release_exists', `This build is already approved for agent ${agent} (release ${short(rid)}).`, `Nothing to do; \`attessa status --agent ${agent}\` shows it.`),
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
  /**
   * FLOWS §5 row 26 names the code `insufficient_gas_funds` but §8 has no row for it. // not in FLOWS: the line and
   * its next action, worded like §8 "gas too low" and "payment invalid" ("Add at least {n} USDC to {address}."), with
   * J0's "CELO for gas at faucet.celo.org/celo-sepolia" only on Celo Sepolia (chain 11142220, `--network sepolia` or a
   * local fork of it); anywhere else, mainnet included, there is no faucet. `tail` is "Nothing was signed." before any
   * signature and "Nothing was sent." once something was signed but not broadcast.
   */
  insufficientGasFunds: (address: string, step: string, maxCost: bigint, chainId: number, tail: 'Nothing was signed.' | 'Nothing was sent.') =>
    new CliError(
      'insufficient_gas_funds',
      `${address} doesn't have enough CELO to pay the gas for ${step} (up to ${celoUp(maxCost)} CELO). ${tail}`,
      chainId === DEPLOYMENTS['celo-sepolia'].chainId
        ? `Add CELO to ${address} at faucet.celo.org/celo-sepolia, then run the command again.`
        : `Add CELO to ${address}, then run the command again.`,
    ),
  // not in FLOWS
  noRegistry: (network: string) =>
    new CliError('no_registry', `No EnclaveRegistry address is known for ${network}.`, 'Set ATTESSA_REGISTRY to the registry address.'),
  // `renewable` false: the signer is expired, revoked or carries an old operator, so renew can't pass and only a new key works.
  // not in FLOWS: a mainnet transaction without the Loops tag can never be credited later.
  attributionRequired: () =>
    new CliError(
      'no_attribution_tag',
      'LOOPS_ATTRIBUTION_TAG is not set, and a mainnet transaction sent without it can never be credited to your Loops entry. Nothing was signed.',
      'Set LOOPS_ATTRIBUTION_TAG to the attribution tag from your Loops entry, then run the command again.',
    ),
  signerExists: (signer: string, renewable = true) =>
    new CliError(
      'signer_exists',
      `Not registered: signer ${short(signer)} is already registered.`,
      renewable ? 'To extend it without a restart: attessa signer renew.' : 'Restart with `attessa enclave start`, then `attessa signer register`.',
    ),
  attestationFromFuture: () =>
    new CliError('attestation_from_future', "Not registered: the machine's report is dated ahead of Celo's clock.", 'Check the host clock, then run `attessa signer register --fresh`.'),
  usage: (msg: string) => new CliError('usage', msg),
} as const;

/**
 * `signer renew` refusals for the checks it shares with registration: FLOWS §8 "R: renew refused" with the
 * register rows' reason words, and advice that works for a running key (a fresh report from the same machine,
 * never `signer register`, which would hit SignerExists). // not in FLOWS: that row names none of these codes.
 */
export const RENEW = {
  // No age: a revert can come blocks after the age was measured.
  attestationStale: () => ERR.renewRefused('attestation_stale', "the machine's report is more than 30 minutes old, the most Celo accepts", false),
  attestationFromFuture: () => ERR.renewRefused('attestation_from_future', "the machine's report is dated ahead of Celo's clock", false),
  certExpired: () => ERR.renewRefused('cert_expired', 'the certificate chain in this attestation has expired', false),
  // The register rows' advice already works for renew.
  endpointInactive: (origin: string, agent: string) =>
    new CliError('endpoint_inactive', `Not renewed: ${origin} isn't an active endpoint for agent ${agent}.`, 'Add it with `attessa endpoint add`.'),
  notOperator: (address: string, origin: string) =>
    new CliError('not_operator', `Not renewed: ${address} isn't the operator for ${origin}.`, 'Run from the operator wallet set in `attessa endpoint add`.'),
  debugMode: () => ERR.renewRefused('debug_pcrs', "the machine was started in debug mode, which AWS doesn't sign for", false),
  wrongBuild: (agent: string, rid: string) =>
    ERR.renewRefused('release_not_approved', `this machine runs a build agent ${agent} hasn't approved (release ${short(rid)})`, false),
  bindingMismatch: (what: string, field: string) => ERR.renewRefused(`binding_mismatch{${field}}`, `the attestation was made for ${what}`, false),
} as const;

// ---------------------------------------------------------------- buyer (FLOWS §6 J0, J1, J2, interrupted; §8)

/** USDC and USA₮ both have 6 decimals (SPEC §2.6 pins). */
export const DECIMALS = 6;

/** 20000n → "0.02"; at least two decimals, as FLOWS writes prices and limits ("0.10", "1.00", "0.005"). */
export function amount(atomic: bigint): string {
  const unit = 10n ** BigInt(DECIMALS);
  let frac = (atomic % unit).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${atomic / unit}.${frac}`;
}

/** "14:02:11" (UTC). */
export function hms(sec: bigint | number): string {
  return new Date(Number(sec) * 1000).toISOString().slice(11, 19);
}

/** 31204245n → "31,204,245". */
export function blockNo(n: bigint | string): string {
  return BigInt(n).toLocaleString('en-US');
}

/** What FLOWS §8 calls `{check in words}`, and the true term after it. Only response_hash_mismatch is in FLOWS (J2). */
export const CHECK_WORDS: Record<string, [string, string]> = {
  response_hash_mismatch: ["the answer doesn't match what the sealed machine signed", 'response hash differs from the proof'],
  // not in FLOWS: the other checks' words.
  missing_proof: ['the answer came without a proof from the sealed machine', 'missing_proof'],
  bad_signature: ["the proof isn't signed by the sealed machine's key", 'bad_signature'],
  request_mismatch: ['the proof is for a different request', 'request_mismatch'],
  payment_mismatch: ['the proof is for a different payment', 'payment_mismatch'],
  inputs_hash_mismatch: ["the Celo data in the answer doesn't match what the proof covers", 'inputs_hash_mismatch'],
  inputs_mismatch: ["the Celo data in the answer doesn't match the chain", 'inputs_mismatch'],
  stale_inputs: ['the answer used Celo data that is too old', 'stale_inputs'],
  clock_skew: ["the proof's time is too far from Celo's clock", 'clock_skew'],
  signer_not_active: ["the machine's key isn't active on Celo", 'signer_not_active'],
  release_not_approved: ["the build that answered isn't approved by its owner", 'release_not_approved'],
  endpoint_mismatch: ['the proof is for a different service address', 'endpoint_mismatch'],
  agent_mismatch: ['the proof is for a different agent', 'agent_mismatch'],
  operator_mismatch: ["the machine's key was registered by a different operator", 'operator_mismatch'],
  proof_expired: ['the proof has expired', 'proof_expired'],
};

/** FLOWS §8 `{tail}` once a payment permission was signed. */
export const SIGNED_TAIL = "Your payment permission wasn't used.";

export const BUY = {
  // §6 J0
  initIntro: 'attessa checks which build a service runs before you pay it, and only pays if the answer checks out.',
  networkSepolia: 'Network: Celo Sepolia (test money). Use --network mainnet for real payments.',
  networkMainnet: 'Network: Celo mainnet (real money).', // not in FLOWS
  networkLocal: (rpc: string) => `Network: local chain at ${rpcShownSafe(rpc)}.`, // not in FLOWS
  walletCreated: (a: string) => `Wallet: none found. Created one for this computer: ${a} (key stored in your OS keychain, never printed)`,
  walletFound: (a: string, from: string) => `Wallet: ${a} (key from ${from}, never printed)`, // not in FLOWS
  fundSepolia: 'Fund it: CELO for gas at faucet.celo.org/celo-sepolia, test USDC at faucet.circle.com (choose Celo Sepolia)',
  fundMainnet: 'Fund it: CELO for gas and USDC on Celo mainnet.', // not in FLOWS
  limits: (per: string, day: string) =>
    `Spending limits: at most ${per} USDC per call and ${day} USDC per day, unless you pass --max-amount / set --daily-cap.`,
  next: 'Next: attessa call https://<service> --body input.json --max-amount 0.05',
  // §6 J1
  checking: (h: string) => `Checking ${h} before paying`,
  runs: (agent: string, rid: string) => `  Runs agent ${agent}'s approved build in a sealed machine the seller can't change  (release ${short(rid)}, Nitro enclave)`,
  ownerSays: (src: string) => `  Owner says it's built from ${src}  (not checked by attessa)`,
  live: (sec: string) => `It's up and answering for this address right now  (liveness check, ${sec} s)`,
  price: (p: string, sym: string, limit: string) => `Price: ${p} ${sym} (your limit per call: ${limit}), paid to the address registered for this service.`,
  sign: "  You sign a payment permission now (free). The service's gateway only uses it if the answer checks out, and it expires in 120 s either way  (EIP-3009 authorization)",
  // not in FLOWS: another live signer of the endpoint answered, on another approved release than the one shown above.
  paidOtherBuild: (p: string, sym: string, release: string, block: string, tx: string, signer: string) =>
    `Paid ${p} ${sym}. The answer came from another approved build of this agent (release ${short(release)}), for this request, using Celo data from block ${block}  (settled: tx ${short(tx)}, signer ${short(signer)})`,
  paid: (p: string, sym: string, block: string, tx: string, signer: string) =>
    `Paid ${p} ${sym}. The answer came from that approved build, for this request, using Celo data from block ${block}  (settled: tx ${short(tx)}, signer ${short(signer)})`,
  saved: (file: string, record: string) => `Answer saved to ${file}. Record: ${record}`,
  // not in FLOWS: the answer is saved but the evidence row couldn't be written (recordNotWritten follows).
  savedNoRecord: (file: string) => `Answer saved to ${file}.`,
  // not in FLOWS: a stored `verified` outcome reported again (a second `cancel`): no answer comes with it, so none is
  // written; the one saved when it arrived stays.
  alreadyVerified: (p: string, sym: string, tx: string, record: string) =>
    `Already done: you were charged ${p} ${sym} (tx ${short(tx)}) and the answer checked out. It was saved when it arrived. Record: ${record}`,
  // not in FLOWS: the same, when --out couldn't be written and the answer was kept beside the record instead.
  alreadyVerifiedKept: (p: string, sym: string, tx: string, kept: string, record: string) =>
    `Already done: you were charged ${p} ${sym} (tx ${short(tx)}) and the answer checked out. It is in ${kept}. Record: ${record}`,
  // not in FLOWS: the same, when this computer has no record that the answer was ever written to a file (the process
  // stopped before it was, or no folder took it).
  alreadyVerifiedNotSaved: (p: string, sym: string, tx: string, record: string) =>
    `Already done: you were charged ${p} ${sym} (tx ${short(tx)}) and the answer checked out, but no saved copy of it is on this computer. Record: ${record}`,
  // SPEC §7 V10
  inputsNotChecked: "  inputs not re-checked (your RPC doesn't keep state that old)",
  dryRun: '  (dry run: nothing was signed)', // not in FLOWS (T15's "(dry run: nothing was sent)" for a call)
  // §6 J2
  refusedCheck: (words: string, term: string) => `Refused: ${words}  (${term})`,
  confirming: (t: string, n: string) => `Confirming you weren't charged: your payment permission expires unused at ${t} UTC (in ${n} s). Waiting…`,
  // not in FLOWS: the wait for the log of a permission the chain already reads used or cancelled.
  usedWaiting: "Your payment permission was already used or cancelled; waiting for Celo to show which…  (up to a minute)",
  voidHint: (id: string) =>
    `  To void it right now instead: attessa cancel ${id}  (on-chain cancel, ~0.0004 CELO gas). Ctrl-C stops waiting; attessa status --pending checks later.`,
  // FLOWS §8 "payment invalid" for insufficient_funds; {n} is the price, which covers the call whatever the balance.
  addFunds: (n: string, sym: string, address: string) => `Add at least ${n} ${sym} to ${address}.`,
  notCharged: (block: string) => `Not charged: confirmed on Celo, your payment permission expired unused  (block ${block})`,
  notChargedCancelled: (block: string) => `Not charged: confirmed on Celo, your payment permission was cancelled  (block ${block})`, // not in FLOWS
  // not in FLOWS: the same lines for an entry stored before the deciding block was recorded (never "(block 0)").
  notChargedNoBlock: 'Not charged: confirmed on Celo, your payment permission expired unused.',
  notChargedCancelledNoBlock: 'Not charged: confirmed on Celo, your payment permission was cancelled.',
  // §6 J2 variant
  // record null: the evidence row couldn't be written (not in FLOWS), so no line cites it.
  paidButRejected: (p: string, sym: string, tx: string, record: string | null, id: string) => [
    `Warning: you were charged ${p} ${sym} (tx ${short(tx)}) but the answer didn't check out  (paid_but_rejected)`,
    "  Payments made this way can't be reversed on chain. Only the gateway operator can send the money back.",
    ...(record ? [`  Your record (${record}, entry ${id}) proves the payment and the failed check.`] : []),
    '  Report the gateway to the marketplace that listed it (for buy: github.com/celo-org/buy-skill/issues).',
  ],
  settledAfterRefusal: (p: string, sym: string, tx: string, record: string | null, id: string) => [
    `Warning: the service refused this call, but your payment permission was used anyway: ${p} ${sym} (tx ${short(tx)}). This is the gateway's fault.`,
    `  ${record ? `Your record (${record}, entry ${id}) proves the payment and the refusal. ` : ''}Report the gateway to the marketplace that listed it.`,
  ],
  // §6 J1 interrupted
  lost: 'Lost the connection after you signed. Checking whether you were charged…  (up to 2 minutes)',
  notChargedAt: (t: string) => `Not charged: confirmed on Celo, your payment permission expired unused at ${t} UTC.`,
  chargedChecksOut: (p: string, sym: string, tx: string) => `Charged ${p} ${sym} (tx ${short(tx)}). Fetching your answer… done. It checks out.`,
  settlePending: (until: string, tx: string | null) =>
    `Payment sent, confirming (usually under 5 s; checking until ${until} UTC)${tx ? `  (tx ${short(tx)})` : ''}`,
  resuming: (id: string) => `You already have a call in progress for this input (request ${id}). Resuming it instead of paying again.`,
  // not in FLOWS: J2's resume line, worded for a --dry-run, which resumes nothing.
  wouldResume: (id: string) => `You already have a call in progress for this input (request ${id}). Without --dry-run, attessa resumes it instead of paying again.`,
  // §7 V10 rpc
  rpcNoHistory: "Can't finish checking: your RPC doesn't have that block's data. Retry with --rpc <archive RPC>.",
  // §8 interrupted, payment found: the chain shows the settlement; the answer comes next.
  paymentFound: (tx: string) => `The payment went through (tx ${short(tx)}). Fetching your answer…`,
  // not in FLOWS: a call left open by --no-wait, or still undecided, with no settlement on chain. Never used once
  // a settlement is known (the permission was used; cancel can't void it).
  stillOpen: (id: string, t: string) =>
    `Not confirmed yet: your payment permission expires unused at ${t} UTC unless the gateway used it. attessa status --pending checks it again; attessa cancel ${id} voids it now.`,
  // not in FLOWS: the two lines above for a call another wallet signed: only that wallet can cancel it (EIP-3009).
  voidHintOther: (payer: string) => `  Only ${payer}, the wallet that signed it, can void it now. Ctrl-C stops waiting; attessa status --pending checks later.`,
  stillOpenOther: (t: string, payer: string) =>
    `Not confirmed yet: your payment permission expires unused at ${t} UTC unless the gateway used it. attessa status --pending checks it again; only ${payer}, the wallet that signed it, can cancel it now.`,
  // §8 cancel
  // not in FLOWS: after "Too late to cancel" or "The payment went through", when the answer isn't served yet (the one
  // next action; never "attessa cancel … voids it now").
  answerNotYet: "The answer isn't confirmed yet. attessa status --pending checks again and fetches it.",
  // not in FLOWS: the call was paid from another wallet than the one loaded (ATTESSA_PRIVATE_KEY, --keystore or the keychain).
  answerOtherWallet: (payer: string) => `The answer isn't confirmed yet, and only the wallet that paid can fetch it. Run attessa status --pending with ${payer}.`,
  tooLateToCancel: (tx: string) => `Too late to cancel: the payment went through (tx ${short(tx)}). Fetching your answer.`,
  cancelled: (tx: string) => `Cancelled (tx ${short(tx)}).`, // not in FLOWS
  noPending: 'No calls in progress.', // not in FLOWS
  // not in FLOWS: the FLOWS:851/:881 oversight line, spend today (settled plus reserved) against the daily cap
  spentToday: (spent: string, cap: string, sym: string, per: string | null) =>
    `Spent today: ${spent} of your ${cap} ${sym} daily cap (${per === null ? 'no per-call limit is set' : `at most ${per} per call`}). It resets at 00:00 UTC.`,
} as const;

/** FLOWS §8 rows for refusals after signing: "{what happened} {tail}". */
export function signedRefusal(rawCode: string, rawDetail: string | undefined): string {
  const t = SIGNED_TAIL;
  const code = safe(rawCode);
  const detail = rawDetail === undefined ? undefined : safe(rawDetail);
  switch (code) {
    case 'execution_timeout':
      return `The service didn't respond in 20 s. ${t}`;
    case 'enclave_unavailable':
      return `The service is offline. ${t}`;
    case 'authorization_expiring':
      return `Not settled: your payment permission expires in under 10 s, too close to settle safely. ${t}`;
    case 'settle_failed':
      return `Payment didn't go through: ${(detail ?? 'unknown').replace(/_/g, ' ')}. The result was withheld. ${t}`;
    case 'payment_invalid':
      return `Not paid: the payment permission was refused because ${(detail ?? 'the facilitator refused it').replace(/_/g, ' ')}.`;
    case 'gateway_paused':
      return `The service can't take payments right now. ${t}`;
    case 'bad_request':
      return `The service can't read this input: ${detail ?? 'no detail'}. ${t}`;
    case 'authorization_window_too_short':
      return `Your payment permission expires too soon for this service (under 40 s left). ${t}`;
    case 'payment_reused':
    case 'request_id_conflict':
      return `This request id or payment permission was already used for a different call. ${t}`;
    case 'gateway_busy':
    case 'rate_limited':
      return `The service is busy. ${t}`; // not in FLOWS: that row's tail is the unpaid one
    default:
      return `Refused: ${code}${detail ? ` (${detail})` : ''}. ${t}`; // not in FLOWS
  }
}

export const BUYERR = {
  // not in FLOWS: the evidence append failed (full disk, permissions); the outcome above stands.
  recordNotWritten: (record: string, dir: string) =>
    new CliError('record_not_written', `Couldn't add this call to your record at ${record}.`, `Free up space in ${dir}, or make it writable, before your next call.`),
  // not in FLOWS: a verified, paid answer that --out couldn't take. The entry is terminal, so it is kept beside the record.
  answerNotWritten: (file: string, p: string, sym: string, tx: string, kept: string) =>
    new CliError(
      'answer_not_written',
      `Couldn't write the answer to ${file}. You were charged ${p} ${sym} (tx ${short(tx)}) and the answer checked out; it is saved in ${kept}.`,
      `Copy ${kept} to where you want it.`,
    ),
  // not in FLOWS: neither --out nor the data folder took it.
  answerNotKept: (file: string, p: string, sym: string, tx: string, dir: string) =>
    new CliError(
      'answer_not_written',
      `Couldn't write the answer to ${file} or to ${dir}. You were charged ${p} ${sym} (tx ${short(tx)}) and the answer checked out, but it wasn't saved.`,
      `Make ${dir} writable before your next call; attessa won't fetch this answer again.`,
    ),
  notRegistered: (origin: string) =>
    new CliError('endpoint_not_registered', `${origin} isn't registered as an attested endpoint.`, 'Pay it without protection using `attessa call --via buy`, or ask the seller to register.'),
  paytoMismatch: (x: string, y: string) =>
    new CliError(
      'payto_mismatch',
      `Not paying: this service asked to be paid at ${x}, but its registered payment address is ${y}. It may be an impostor.`,
      "Don't retry. Report it to where you found the link (for buy: github.com/celo-org/buy-skill/issues).",
    ),
  // §6 J1 "Price above the limit" (§8's row has shorter words; the dialog's are used).
  overMax: (p: string, sym: string, m: string) =>
    new CliError('over_max_amount', `Not paying: the price is ${p} ${sym} and your limit per call is ${m}. Pass --max-amount ${p} if that's fine. Nothing was signed.`, `Raise --max-amount to ${p} if that's fine.`, true),
  overDailyCap: (s: string, c: string) =>
    new CliError('over_daily_cap', `Not paying: this would take today's spend to ${s} USDC; your cap is ${c}.`, 'Wait until 00:00 UTC or raise `--daily-cap`.'),
  livenessFailed: (origin: string, reason: string) =>
    new CliError(
      `liveness_failed{${safe(reason)}}`,
      `Not paying: the sealed machine for ${origin} didn't answer a fresh check, so it may be down or this may not be the real address  (liveness).`,
      `\`attessa status ${origin}\` shows when it last answered.`,
    ),
  maxAmountRequired: () =>
    new CliError(
      'max_amount_required',
      'No per-call limit is set, so nothing was signed.',
      'Run `attessa init` or pass --max-amount in USDC (for example --max-amount 0.05).',
    ),
  noWallet: () => new CliError('no_wallet', 'No wallet set up yet.', 'Run `attessa init`.'),
  endpointRetired: (origin: string, a: string) =>
    new CliError('endpoint_retired', `${origin} has stopped selling (its owner retired it). Nothing was signed.`, `\`attessa status --agent ${a}\` lists its current endpoints.`),
  quoteUnavailable: (origin: string, got: string) =>
    new CliError('quote_unavailable', `${origin} didn't ask for payment the expected way (got ${got}). Nothing was signed.`, `Check the URL; \`attessa status ${origin}\` shows the registered path.`),
  quoteMalformed: (origin: string) =>
    new CliError('quote_malformed', `${origin} asked for payment in a form this version can't read. Nothing was signed.`, 'Update with `npm i -g @attessa/cli`.'),
  originAgentMismatch: (origin: string, x: string, y: string) =>
    new CliError(
      'origin_agent_mismatch',
      `Not paying: ${origin} says it's agent ${x}, but the registry has it as agent ${y}. Nothing was signed.`,
      "Don't retry. Report it to where you found the link.",
    ),
  // not in FLOWS: .well-known unreadable, or its registry/chain differ (no agent pair to name).
  originUnverifiable: (origin: string, detail: string) =>
    new CliError(
      'origin_agent_mismatch',
      `Not paying: ${origin} doesn't publish the identity the registry has for it (${safe(detail)}). Nothing was signed.`,
      "Don't retry. Report it to where you found the link.",
    ),
  gatewayPaused: (origin: string) => new CliError('gateway_paused', "The service can't take payments right now. Nothing was signed.", `\`attessa status ${origin}\`.`),
  badRequest: (detail: string) => new CliError('bad_request', `The service can't read this input: ${safe(detail)}. Nothing was signed.`, 'Fix the input and call again.'),
  busy: (code: string) => new CliError(code, 'The service is busy. Nothing was signed.', 'Try again in a few seconds.'), // FLOWS: "Try again in {n} s."; the SDK doesn't return Retry-After
  nothingToExport: () => new CliError('nothing_to_export', "No calls recorded yet, so there's nothing to export.", 'Make one with `attessa call`.'),
  resultNotFound: (id: string) => new CliError('result_not_found', `No stored result for request ${id}.`, 'Check `attessa status --pending`.'),
  // not in FLOWS
  noKeychain: () =>
    new CliError('no_keychain', "No OS keychain is available, so no wallet was created.", 'Set ATTESSA_PRIVATE_KEY or pass --keystore <file> (password in ATTESSA_KEYSTORE_PASSWORD).'),
  unknownRequest: (id: string) => new CliError('unknown_request', `No call with request id ${id} in this computer's record.`, 'Check `attessa status --pending`.'),
  /**
   * `attessa cancel` when the cancel reverts while the permission still reads as unused (a paused token, say). The
   * line is the registry writes' generic revert line (not in FLOWS) when nothing was sent; the next action is the
   * one thing that settles it: the permission expires unused at validBefore unless the gateway used it. // not in FLOWS
   */
  cancelReverted: (validBefore: string, tx?: string) =>
    new CliError(
      'reverted',
      tx ? `The cancel transaction reverted (tx ${short(tx)}).` : 'The transaction would revert. Nothing was sent.',
      `Run attessa status --pending after ${validBefore} UTC to confirm whether you were charged.`,
    ),
  /** The cancel was sent and the node answers, but it isn't mined within the receipt wait. // not in FLOWS */
  cancelUnconfirmed: (tx: string) =>
    new CliError('tx_unconfirmed', `The cancel was sent (tx ${tx}) but isn't confirmed yet.`, 'Run `attessa status --pending` to see whether it landed.'),
  /** The RPC dropped after the cancel permission was signed, before its transaction was sent. // not in FLOWS: the rpc row's tail for it. */
  cancelNotSent: (rpc: string) => new CliError('rpc_unavailable', `Can't reach Celo at ${rpcShownSafe(rpc)}. Nothing was sent.`, 'Retry or set another `--rpc`.'),
  /** The token's one flag reads "used or cancelled" but neither log has appeared yet. // not in FLOWS */
  cancelUndecided: () =>
    new CliError('uncertain', "Your payment permission was already used or cancelled, but Celo doesn't show which yet.", 'Run attessa status --pending in a minute to see which.'),
  inProgress: () => new CliError('in_progress', 'This call is already running in another attessa process. Nothing was signed.', 'Check `attessa status --pending`.'),
} as const;

// ---------------------------------------------------------------- owner (FLOWS §6 J3 agent register, J4; §8)

export const OWN = {
  // §6 J3
  registerPrompt: (cost: string) => `This creates your agent's public identity (ERC-8004) from this wallet. One transaction, about ${cost} CELO.  [register/cancel]`,
  registered: (agent: string, tx: string) => `Registered: agent ${agent}  (tx ${short(tx)}). Next: attessa enclave build.`,
  // §6 J4
  revokeReleasePrompt: (src: string, live: number, hosts: string[]) =>
    `This stops buyers paying for answers from this build (owner says ${src}). ${
      live === 0
        ? 'It has no live signers.' // not in FLOWS
        : `Its ${live} live signer${live === 1 ? ' stops' : 's stop'} working within 60 s${
            hosts.length === 0
              ? '; another approved build still serves its endpoints.' // not in FLOWS
              : `, and ${hosts.join(' and ')} ${hosts.length === 1 ? 'refuses' : 'refuse'} calls until you approve and register another build.`
          }`
    } Revoking is permanent.  [revoke/cancel]`,
  revoked: (tx: string) => `Revoked (tx ${short(tx)}).`,
  // not in FLOWS: the other owner prompts.
  deprecatePrompt: (src: string) =>
    `This stops new calls to this build (owner says ${src}); answers it already gave stay valid. You can approve it again later.  [deprecate/cancel]`,
  deprecated: (tx: string) => `Deprecated (tx ${short(tx)}).`,
  // `stopped`: the signer already can't sign (FLOWS §7 Expired or Inert), so revoking only makes that permanent. // not in FLOWS
  revokeSignerPrompt: (signer: string, h: string, agent: string, stopped: 'Expired' | 'Inert' | null = null) =>
    stopped
      ? `Signer ${short(signer)} for ${h} (agent ${agent}) is already ${stopped} and signs nothing; revoking makes that permanent. The operator registers a new key to continue.  [revoke/cancel]`
      : `This stops signer ${short(signer)} for ${h} (agent ${agent}) within 60 s. Revoking is permanent; the operator registers a new key to continue.  [revoke/cancel]`,
  retirePrompt: (h: string, agent: string) =>
    `Buyers of ${h} stop paying agent ${agent}, and its signers stop working within 60 s. You can add it again later.  [retire/cancel]`,
  retired: (tx: string) => `Retired (tx ${short(tx)}).`,
  transferPrompt: (agent: string, to: string) => `This transfers agent ${agent} to ${to}, which becomes its owner. One transaction.  [transfer/cancel]`,
  transferred: (tx: string) => `Transferred (tx ${short(tx)}). Next, on the EC2 host: attessa agent wallet-sig.`,
  walletSig: (agent: string, wallet: string, sig: string, deadline: string, until: string) => [
    `Signed: agent ${agent}'s wallet becomes ${wallet} if the owner submits this before ${until}.`,
    `Next, from the owner wallet: attessa agent set-wallet --agent ${agent} --wallet ${wallet} --sig ${sig} --deadline ${deadline}`,
  ],
  setWalletPrompt: (agent: string, wallet: string) => `This sets agent ${agent}'s wallet to ${wallet}. One transaction.  [set/cancel]`,
  walletSet: (tx: string) => `Wallet set (tx ${short(tx)}).`,
  selflinkPrompt: (agent: string, sid: string) => `This links agent ${agent} to Self Agent ID ${sid} (informational). One transaction.  [link/cancel]`,
  linked: (tx: string) => `Linked (tx ${short(tx)}).`,
} as const;

export const OWNERR = {
  unknownRelease: (agent: string, id: string) => new CliError('unknown_release', `Agent ${agent} has no release ${id}.`, `\`attessa status --agent ${agent}\` lists them.`),
  unknownSigner: (agent: string, id: string) => new CliError('unknown_signer', `Agent ${agent} has no signer ${id}.`, `\`attessa status --agent ${agent}\` lists them.`),
  selfLinkInvalid: (sid: string) =>
    new CliError(
      'self_link_invalid',
      `Can't link Self Agent ID ${sid}: it must be held by this wallet (Self's linked mode) and have a current human proof.`,
      'Check it in the Self app, then run `attessa selflink` again.',
    ),
  // not in FLOWS
  noSuchRelease: (id: string) => new CliError('unknown_release', `No agent has approved release ${id} on this network.`, 'Check the id with `attessa status --agent <id>`.'),
  ambiguousRelease: (id: string, agents: string[]) =>
    new CliError('usage', `Release ${id} is approved for agents ${agents.join(', ')}.`, 'Pass --agent <id>.'),
  invalidTransition: (id: string, status: string) =>
    new CliError('invalid_transition', `Release ${short(id)} is ${status}; that change isn't allowed.`, '`attessa status --agent <id>` lists each release and its state.'),
  signerNotActive: (id: string) => new CliError('signer_not_active', `Signer ${short(id)} is already revoked.`, '`attessa status --agent <id>` lists the signers.'),
  endpointNotActive: (origin: string) => new CliError('endpoint_not_active', `${origin} isn't an active endpoint.`, '`attessa status --agent <id>` lists the endpoints.'),
  unknownAgent: (agent: string) => new CliError('unknown_agent', `Agent ${agent} doesn't exist on this network's identity registry.`, 'Check --agent and --network.'),
  selfDisabled: () => new CliError('self_disabled', 'Self linking is turned off in this registry.', 'Skip `attessa selflink`: it is optional, and the agent works without it.'),
} as const;
