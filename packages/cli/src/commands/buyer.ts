import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEPLOYMENTS, normalizeOrigin } from '@attessa/core';
import {
  AlreadyUsedError,
  KeyError,
  Ledger,
  createAttestClient,
  loadAccount,
  spendToday,
  type AssetKey,
  type AttestClient,
  type AttestConfig,
  type CallResult,
  type ClientOptions,
  type EvidenceRow,
  type Limits,
  type PendingEntry,
  type Progress,
} from '@attessa/sdk';
import type { Hex, LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DEFAULT_RPC, type Deps, type Global, type NetworkFlag } from '../context.ts';
import { BUY, BUYERR, CliError, DECIMALS, ERR, amount, blockNo, checkWords, hms, host, safe, signedRefusal } from '../copy.ts';

/** Buyer commands (SPEC §8): `init`, `call`, `cancel`, `status [<origin>] [--pending]`, `evidence export`. All payment logic is the SDK's. */

const SYMBOL: Record<AssetKey, string> = { usdc: 'USDC', usat: 'USA₮' };

/** The pinned asset key for a token address (SPEC §2.6), USDC when unknown. */
function assetOf(address: string): AssetKey {
  const a = address.toLowerCase();
  for (const dep of Object.values(DEPLOYMENTS)) if (dep.assets.usat?.address.toLowerCase() === a) return 'usat';
  return 'usdc';
}
const REQUEST_ID = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** FLOWS §6 J0 defaults. */
export const DEFAULT_LIMITS = { maxAmountPerCall: '0.10', dailyCap: '1.00' } as const;

/** `<dataDir>/config.json`, written by `attessa init`. Amounts are decimal strings in token units. */
export interface BuyerConfig {
  network?: NetworkFlag;
  limits?: Partial<Record<AssetKey, { maxAmountPerCall?: string; dailyCap?: string }>>;
}

export function dataDir(d: Deps): string {
  return d.env.ATTESSA_DATA_DIR || join(d.home ?? homedir(), '.attessa');
}

/** `/home/x/.attessa/evidence.jsonl` → `~/.attessa/evidence.jsonl`. */
function display(d: Deps, p: string): string {
  const h = d.home ?? homedir();
  return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

export function readConfig(d: Deps): BuyerConfig | null {
  const p = join(dataDir(d), 'config.json');
  let text: string;
  try {
    text = d.readFile(p).toString('utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as BuyerConfig;
  } catch {
    throw ERR.usage(`${p} isn't valid JSON. Run attessa init again.`);
  }
}

export function parseAmount(v: string, flag: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v);
  if (!m) throw ERR.usage(`${flag} must be an amount in USDC, like 0.05.`);
  return BigInt(m[1]!) * 10n ** BigInt(DECIMALS) + BigInt((m[2] ?? '').padEnd(DECIMALS, '0'));
}

function parseAsset(v: string | undefined): AssetKey {
  if (v === undefined) return 'usdc';
  if (v !== 'usdc' && v !== 'usat') throw ERR.usage('--asset must be usdc or usat.');
  return v;
}

/** Per-call limit: `--max-amount` (raises or lowers it for this call, FLOWS J1), else init's; daily cap likewise, else 1.00. */
function limitsFor(cfg: BuyerConfig | null, o: { maxAmount?: string | undefined }, asset: AssetKey): Record<AssetKey, Limits> {
  const saved = cfg?.limits?.[asset];
  const per = o.maxAmount ?? saved?.maxAmountPerCall;
  if (per === undefined) throw BUYERR.maxAmountRequired();
  const l: Limits = {
    maxAmountPerCall: parseAmount(per, '--max-amount'),
    dailyCap: parseAmount(saved?.dailyCap ?? DEFAULT_LIMITS.dailyCap, '--daily-cap'), // only `init` sets it: a per-call flag would let one call lift the cap
  };
  const none: Limits = { maxAmountPerCall: 0n, dailyCap: 0n };
  return { usdc: asset === 'usdc' ? l : none, usat: asset === 'usat' ? l : none };
}

const NO_LIMITS: Record<AssetKey, Limits> = { usdc: { maxAmountPerCall: 0n, dailyCap: 0n }, usat: { maxAmountPerCall: 0n, dailyCap: 0n } };

/** The buyer key: ATTESSA_PRIVATE_KEY, then --keystore, then the OS keychain (SPEC §7). Never printed. */
async function wallet(d: Deps, keystore: string | undefined, create = false) {
  const opts: Parameters<typeof loadAccount>[0] = { env: d.env, create };
  if (keystore !== undefined) {
    const password = d.env.ATTESSA_KEYSTORE_PASSWORD;
    if (password === undefined) throw ERR.usage('--keystore needs the keystore password in ATTESSA_KEYSTORE_PASSWORD.');
    opts.keystore = { path: resolve(d.cwd, keystore), password };
  }
  if (d.keychain !== undefined) opts.keychain = d.keychain;
  try {
    return await loadAccount(opts);
  } catch (e) {
    // Never print an error's own text here: a parser quotes its input, and the input may be a key (SPEC §7
    // "Never printed"). Only the SDK's fixed KeyError reasons and the path the user typed get out. // not in FLOWS
    if (!(e instanceof KeyError)) throw new CliError('bad_key', "Can't load the wallet.");
    const where = e.source === 'keystore' && keystore !== undefined ? ` from ${safe(keystore)}` : e.source === 'env' ? ' from ATTESSA_PRIVATE_KEY' : ' from your OS keychain';
    throw new CliError('bad_key', `Can't load the wallet${where}: ${e.reason}.`);
  }
}

function rpcUrl(g: Global): string {
  if (g.rpc) return g.rpc;
  if (g.network === 'local') throw ERR.usage('--network local needs --rpc.');
  return DEFAULT_RPC[g.network];
}

function makeClient(
  g: Global,
  d: Deps,
  account: LocalAccount,
  o: { limits: Record<AssetKey, Limits>; asset: AssetKey; wait: boolean; onProgress?: (e: Progress) => void | 'stop' },
): AttestClient {
  const cfg: AttestConfig = {
    network: g.network === 'mainnet' ? 'celo' : g.network === 'sepolia' ? 'celo-sepolia' : 'local',
    rpcUrl: rpcUrl(g),
    account,
    limits: o.limits,
    asset: o.asset,
    dataDir: dataDir(d),
    waitForExpiry: o.wait,
  };
  const opts: ClientOptions = { ...d.sdk };
  // As for the seller commands: a deployed registry is authoritative; ATTESSA_REGISTRY only fills in before deploy.
  const reg = d.env.ATTESSA_REGISTRY;
  const deployed = g.network === 'local' ? null : DEPLOYMENTS[g.network === 'mainnet' ? 'celo' : 'celo-sepolia'].enclaveRegistry;
  if (!deployed && reg) {
    if (!ADDRESS.test(reg)) throw ERR.usage('ATTESSA_REGISTRY must be an address.');
    opts.registry = reg.toLowerCase() as Hex;
  }
  if (o.onProgress) opts.onProgress = o.onProgress;
  return createAttestClient(cfg, opts);
}

/** FLOWS J1 shows the owner's claim as `github.com/acme/risk @ a1b2c3d`; escaped on every path (KNOWN-LIMITS L20). */
function claimLabel(ref: string): string {
  const m = /^(?:https:\/\/)?(github\.com\/[^/\s@]+\/[^/\s@]+?)(?:\/(?:commit|tree)\/|@)([0-9a-f]{7,40})\/?$/i.exec(ref);
  return safe(m ? `${m[1]} @ ${m[2]!.slice(0, 7)}` : ref);
}

function lastEvidence(client: AttestClient, requestId: Hex): EvidenceRow | undefined {
  return client.ledger.readEvidence().filter((r) => r.requestId === requestId).at(-1);
}

function jsonResult(r: CallResult): Record<string, unknown> {
  const out: Record<string, unknown> = { outcome: r.outcome, requestId: r.requestId };
  if (r.code) out.code = r.code;
  if (r.detail) out.detail = r.detail;
  if (r.check) out.check = r.check;
  if (r.amount !== undefined) out.amount = r.amount.toString();
  if (r.asset) out.asset = r.asset;
  if (r.payTo) out.payTo = r.payTo;
  if (r.settlementTx) out.settlementTx = r.settlementTx;
  if (r.signer) out.signer = r.signer;
  if (r.ownerClaimedSource !== undefined) out.ownerClaimedSource = r.ownerClaimedSource;
  if (r.inputsChecked !== undefined) out.inputsChecked = r.inputsChecked;
  if (r.confirmedAtBlock !== undefined) out.confirmedAtBlock = r.confirmedAtBlock.toString();
  return out;
}

// ---------------------------------------------------------------- init (J0)

export async function init(
  g: Global,
  d: Deps,
  o: { networkFlag: boolean; maxAmount?: string | undefined; dailyCap?: string | undefined; keystore?: string | undefined },
): Promise<number> {
  const out = d.io.out;
  const dir = dataDir(d);
  const cfg = readConfig(d) ?? {};
  const limits = { ...DEFAULT_LIMITS, ...cfg.limits?.usdc };
  if (o.maxAmount !== undefined) {
    parseAmount(o.maxAmount, '--max-amount');
    limits.maxAmountPerCall = o.maxAmount;
  }
  if (o.dailyCap !== undefined) {
    parseAmount(o.dailyCap, '--daily-cap');
    limits.dailyCap = o.dailyCap;
  }
  out(BUY.initIntro);
  out(g.network === 'sepolia' ? BUY.networkSepolia : g.network === 'mainnet' ? BUY.networkMainnet : BUY.networkLocal(rpcUrl(g)));
  const w = await wallet(d, o.keystore, true);
  if (!w) throw BUYERR.noKeychain();
  const addr = w.account.address.toLowerCase();
  out(
    w.source === 'created'
      ? BUY.walletCreated(addr)
      : BUY.walletFound(addr, w.source === 'env' ? 'ATTESSA_PRIVATE_KEY' : w.source === 'keystore' ? '--keystore' : 'your OS keychain'),
  );
  out(g.network === 'sepolia' ? BUY.fundSepolia : BUY.fundMainnet);
  out(BUY.limits(amount(parseAmount(limits.maxAmountPerCall, '--max-amount')), amount(parseAmount(limits.dailyCap, '--daily-cap'))));
  out(BUY.next);
  const next: BuyerConfig = {
    network: o.networkFlag || !cfg.network ? g.network : cfg.network,
    limits: { ...cfg.limits, usdc: limits, usat: { ...DEFAULT_LIMITS, ...cfg.limits?.usat } },
  };
  new Ledger(dir); // creates the data dir, 0700
  d.writeFile(join(dir, 'config.json'), `${JSON.stringify(next, null, 2)}\n`);
  d.io.data?.({ address: addr, keySource: w.source, network: next.network, dataDir: dir });
  return 0;
}

// ---------------------------------------------------------------- call (J1, J2, interrupted)

export interface CallOpts {
  url?: string | undefined;
  body?: string | undefined;
  maxAmount?: string | undefined;
  asset?: string | undefined;
  newRequest: boolean;
  noWait: boolean;
  out?: string | undefined;
  keystore?: string | undefined;
}

export async function call(g: Global, d: Deps, o: CallOpts, cfg: BuyerConfig | null): Promise<number> {
  if (!o.url) throw ERR.usage('Usage: attessa call <url> --body <file|json>');
  if (o.body === undefined) throw ERR.usage('--body <file|json> is required.');
  let origin: string;
  try {
    origin = normalizeOrigin(o.url, { local: g.network === 'local' });
  } catch {
    throw ERR.usage('attessa call needs the service URL, like https://risk.example/v1/evaluate.');
  }
  const asset = parseAsset(o.asset);
  const body = /^\s*[[{]/.test(o.body) ? o.body : readBody(d, o.body);
  const limits = limitsFor(cfg, o, asset);
  const w = await wallet(d, o.keystore);
  if (!w) throw BUYERR.noWallet();
  const out = d.io.out;
  const sym = SYMBOL[asset];
  const seen = { uncertain: false };
  out(BUY.checking(host(origin)));
  const client = makeClient(g, d, w.account, {
    limits,
    asset,
    wait: !o.noWait,
    onProgress: (e) => {
      switch (e.kind) {
        case 'resuming':
          out(BUY.resuming(e.entry.requestId));
          return;
        case 'authorizing':
          out(BUY.runs(e.endpoint.agentId.toString(), e.releaseId));
          if (e.ownerClaimedSource !== undefined) out(BUY.ownerSays(claimLabel(e.ownerClaimedSource)));
          out(BUY.live((e.quoteMs / 1000).toFixed(1)));
          out(BUY.price(amount(e.amount), sym, amount(e.maxAmount)));
          out(BUY.sign);
          return g.dryRun ? 'stop' : undefined;
        case 'refused':
          if (e.code === 'proof_rejected') {
            const [words, term] = checkWords(e.detail) ?? [`the proof failed a check (${safe(e.detail ?? 'unnamed')})`, 'proof_rejected'];
            out(BUY.refusedCheck(words, term));
          } else {
            out(signedRefusal(e.code, e.detail));
          }
          return;
        case 'uncertain':
          if (!seen.uncertain) out(BUY.lost);
          seen.uncertain = true;
          return;
        case 'settle_pending':
          out(BUY.settlePending(hms(BigInt(e.entry.validBefore!) + 60n), e.tx));
          return;
        case 'waiting': {
          if (e.entry.state !== 'refused') return;
          const vb = BigInt(e.entry.validBefore!);
          out(BUY.confirming(hms(vb), String(vb > e.chainNow ? vb - e.chainNow : 0n)));
          out(BUY.voidHint(e.entry.requestId));
          return;
        }
      }
    },
  });
  const r = await client.payAndVerify(o.url, { body, asset, newRequest: o.newRequest });
  return report(g, d, client, r, { origin, sym, asset, uncertain: seen.uncertain, outFile: o.out ?? 'result.json', dailyCap: limits[asset].dailyCap });
}

function readBody(d: Deps, file: string): Uint8Array {
  try {
    return new Uint8Array(d.readFile(resolve(d.cwd, file)));
  } catch {
    throw ERR.usage(`Can't read ${file}. --body takes a JSON file or inline JSON.`);
  }
}

/** The end state of a call, in FLOWS §6 words. Exit 0 only for `verified` (and a dry run). */
async function report(
  g: Global,
  d: Deps,
  client: AttestClient,
  r: CallResult,
  c: { origin: string; sym: string; asset: AssetKey; uncertain: boolean; outFile: string; dailyCap: bigint },
): Promise<number> {
  const out = d.io.out;
  d.io.data?.(jsonResult(r));
  const p = amount(r.amount ?? 0n);
  const record = display(d, client.ledger.evidencePath);
  const entry = (): PendingEntry | undefined => client.ledger.get(r.requestId);
  switch (r.outcome) {
    case 'verified': {
      d.writeFile(resolve(d.cwd, c.outFile), r.response ?? new Uint8Array());
      if (c.uncertain) out(BUY.chargedChecksOut(p, c.sym, r.settlementTx!));
      else out(BUY.paid(p, c.sym, blockNo(lastEvidence(client, r.requestId)?.inputsBlock ?? '0'), r.settlementTx!, r.signer!));
      if (r.inputsChecked === false) out(BUY.inputsNotChecked);
      out(BUY.saved(c.outFile, record));
      return 0;
    }
    case 'not_charged': {
      const b = blockNo(r.confirmedAtBlock ?? 0n);
      if (r.code === 'cancelled') out(BUY.notChargedCancelled(b));
      else if (c.uncertain) out(BUY.notChargedAt(hms(BigInt(entry()?.validBefore ?? '0'))));
      else out(BUY.notCharged(b));
      return 1;
    }
    case 'paid_but_rejected':
      for (const l of BUY.paidButRejected(p, c.sym, r.settlementTx ?? '', record, r.requestId)) out(l);
      return 1;
    case 'settled_after_refusal':
      for (const l of BUY.settledAfterRefusal(p, c.sym, r.settlementTx ?? '', record, r.requestId)) out(l);
      return 1;
    case 'refused':
    case 'uncertain':
      if (r.code === 'rpc_unavailable' && r.settlementTx) out(BUY.rpcNoHistory);
      else out(BUY.stillOpen(r.requestId, hms(BigInt(entry()?.validBefore ?? '0'))));
      return 1;
    case 'stopped':
      if (r.code === 'dry_run') {
        out(BUY.dryRun);
        return 0;
      }
      throw await stoppedError(g, client, r, c);
    case 'unattested':
      return 1;
  }
}

/** FLOWS §8 rows for a call that stopped before anything was signed. */
async function stoppedError(g: Global, client: AttestClient, r: CallResult, c: { origin: string; sym: string; asset: AssetKey; dailyCap: bigint }): Promise<CliError> {
  const detail = safe(r.detail ?? ''); // the gateway's or chain's words, never printed raw
  const nums = (re: RegExp) => re.exec(detail);
  switch (r.code) {
    case 'endpoint_not_registered':
      return BUYERR.notRegistered(c.origin);
    case 'endpoint_retired': {
      // The retired record keeps its agent (SPEC §3.4 retireEndpoint).
      const agent = await client.status(c.origin).then((s) => s.agentId?.toString(), () => undefined);
      return BUYERR.endpointRetired(c.origin, agent ?? '<id>');
    }
    case 'origin_agent_mismatch': {
      const m = nums(/says agent (\S+), registry says (\S+)$/);
      return m ? BUYERR.originAgentMismatch(c.origin, m[1]!, m[2]!) : BUYERR.originUnverifiable(c.origin, detail);
    }
    case 'rpc_unavailable':
      return ERR.rpcUnavailable(rpcUrl(g));
    case 'network_mismatch': {
      const m = nums(/^RPC is on chain (\d+); \S+ is (\d+)$/);
      return m ? ERR.networkMismatch(Number(m[1]), Number(m[2])) : new CliError('network_mismatch', `Wrong network: ${detail}. Nothing was signed.`);
    }
    case 'quote_unavailable': {
      const m = nums(/^HTTP (\d+)$/);
      return BUYERR.quoteUnavailable(c.origin, m ? `HTTP ${m[1]}` : 'no HTTP answer');
    }
    case 'quote_malformed':
      return BUYERR.quoteMalformed(c.origin);
    case 'gateway_paused':
      return BUYERR.gatewayPaused(c.origin);
    case 'bad_request':
      return BUYERR.badRequest(detail || 'no detail');
    case 'rate_limited':
    case 'gateway_busy':
      return BUYERR.busy(r.code);
    case 'payto_mismatch': {
      const m = nums(/^quote payTo (\S+), registry payTo (\S+)$/);
      return BUYERR.paytoMismatch(m?.[1] ?? 'another address', m?.[2] ?? 'the registered one');
    }
    case 'over_max_amount': {
      const m = nums(/^price (\d+), max (\d+)$/);
      return BUYERR.overMax(amount(BigInt(m?.[1] ?? '0')), c.sym, amount(BigInt(m?.[2] ?? '0')));
    }
    case 'over_daily_cap': {
      const ev = lastEvidence(client, r.requestId);
      const price = BigInt(ev?.amount ?? '0');
      const spent = ev?.asset ? spendToday(client.ledger.list(), ev.asset, Date.now()) : 0n;
      return BUYERR.overDailyCap(amount(spent + price), amount(c.dailyCap));
    }
    case 'liveness_failed':
      return BUYERR.livenessFailed(c.origin, detail || 'unknown');
    case 'in_progress':
      return BUYERR.inProgress();
    default:
      return new CliError(safe(r.code ?? 'stopped'), `Stopped: ${safe(r.code ?? 'unknown')}${detail ? ` (${detail})` : ''}. Nothing was signed.`); // not in FLOWS
  }
}

// ---------------------------------------------------------------- cancel

export async function cancel(g: Global, d: Deps, o: { id?: string | undefined; keystore?: string | undefined }): Promise<number> {
  if (!o.id || !REQUEST_ID.test(o.id)) throw ERR.usage('Usage: attessa cancel <requestId> (0x followed by 64 hex characters).');
  const id = o.id.toLowerCase() as Hex;
  const w = await wallet(d, o.keystore);
  if (!w) throw BUYERR.noWallet();
  const client = makeClient(g, d, w.account, { limits: NO_LIMITS, asset: 'usdc', wait: true });
  const entry = client.ledger.get(id);
  if (!entry) throw BUYERR.unknownRequest(id);
  const ctx = (e: PendingEntry) => ({ origin: e.origin, sym: SYMBOL[assetOf(e.asset)], asset: assetOf(e.asset), uncertain: false, outFile: `${id}.json`, dailyCap: 0n });
  if (entry.nonce === null) throw new CliError('nothing_signed', 'Nothing was signed for this request, so there is nothing to cancel.'); // not in FLOWS
  if (['verified', 'not_charged', 'paid_but_rejected', 'settled_after_refusal'].includes(entry.state)) {
    return report(g, d, client, await client.getResult(id), ctx(entry));
  }
  if (g.dryRun) {
    d.io.out('  (dry run: nothing was sent)');
    return 0;
  }
  if (!g.yes && !(await d.io.confirm('cancel'))) return 1;
  try {
    const tx = await client.cancelAuthorization(id);
    d.io.out(BUY.cancelled(tx));
    d.io.data?.({ requestId: id, outcome: 'not_charged', code: 'cancelled', cancelTx: tx });
    return 0;
  } catch (e) {
    if (!(e instanceof AlreadyUsedError)) throw e;
    d.io.out(BUY.tooLateToCancel(e.tx ?? ''));
    return report(g, d, client, await client.getResult(id), ctx(entry));
  }
}

// ---------------------------------------------------------------- status [<origin>] [--pending]

export async function status(g: Global, d: Deps, o: { target?: string | undefined; pending: boolean; keystore?: string | undefined }): Promise<number> {
  const out = d.io.out;
  if (o.target === undefined || o.pending) {
    const w = await wallet(d, o.keystore);
    if (!w) throw BUYERR.noWallet();
    const client = makeClient(g, d, w.account, { limits: NO_LIMITS, asset: 'usdc', wait: false });
    let results = await client.reconcilePending();
    if (o.target !== undefined) {
      const oh = (await client.status(o.target)).originHash;
      results = results.filter((r) => client.ledger.get(r.requestId)?.originHash === oh);
    }
    d.io.data?.({ pending: results.map(jsonResult) });
    if (results.length === 0) out(BUY.noPending);
    for (const r of results) {
      const e = client.ledger.get(r.requestId);
      const asset = assetOf(e?.asset ?? '');
      const c = { origin: e?.origin ?? '', sym: SYMBOL[asset], asset, uncertain: false, outFile: `${r.requestId}.json`, dailyCap: 0n };
      out(`${r.requestId}  ${host(c.origin)}`); // not in FLOWS
      if (r.outcome === 'stopped') continue;
      await report(g, d, client, r, c);
    }
    return 0;
  }
  // `status <origin>`: the registry entry and a fresh liveness check; no wallet needed.
  const w = await wallet(d, o.keystore);
  const account = w?.account ?? privateKeyToAccount(generatePrivateKey()); // read-only: this client never signs
  const client = makeClient(g, d, account, { limits: NO_LIMITS, asset: 'usdc', wait: false });
  try {
    normalizeOrigin(o.target, { local: g.network === 'local' });
  } catch {
    throw ERR.invalidOrigin();
  }
  let s;
  try {
    s = await client.status(o.target);
  } catch {
    throw ERR.rpcUnavailable(rpcUrl(g));
  }
  if (s.endpoint?.status === 'none') throw BUYERR.notRegistered(s.origin!);
  // not in FLOWS: the status lines.
  out(`${host(s.origin!)}: agent ${s.agentId}, endpoint ${s.endpoint!.status}, pays ${s.endpoint!.payTo}`);
  let live: Record<string, unknown> = {};
  if (s.endpoint?.status === 'active') {
    let l;
    try {
      l = await client.checkLiveness(s.origin!);
    } catch (e) {
      l = { ok: false, reason: (e as Error).message };
    }
    live = { ok: l.ok, ...(l.reason ? { reason: l.reason } : {}), ...(l.signer ? { signer: l.signer } : {}) };
    out(l.ok ? BUY.live(((l.latencyMs ?? 0) / 1000).toFixed(1)) : `It didn't answer a fresh check just now  (liveness: ${safe(l.reason ?? 'unknown')})`);
  }
  out(`${s.pending.length} call${s.pending.length === 1 ? '' : 's'} in progress with it on this computer.`);
  d.io.data?.({
    origin: s.origin,
    agentId: s.agentId?.toString(),
    endpoint: s.endpoint,
    liveness: live,
    pending: s.pending.map((e) => e.requestId),
  });
  return 0;
}

// ---------------------------------------------------------------- evidence export

const EVIDENCE_COLUMNS: (keyof EvidenceRow)[] = [
  'v', 'ts', 'requestId', 'origin', 'agentId', 'outcome', 'code', 'check', 'amount', 'asset', 'payTo', 'settlementTx', 'signer', 'releaseId',
  'ownerClaimedSource', 'selfVerifiedOwner', 'requestHash', 'responseHash', 'inputsHash', 'inputsBlock', 'inputsChecked', 'via',
];

/** RFC 4180 quoting, and OWASP's CSV-injection rule: a cell starting with = + - @ tab or CR gets a leading `'`. */
function csvCell(v: unknown): string {
  const raw = v === null || v === undefined ? '' : String(v);
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function evidenceExport(_g: Global, d: Deps, o: { format?: string | undefined }): Promise<number> {
  const format = o.format ?? 'csv';
  if (format !== 'csv' && format !== 'jsonl') throw ERR.usage('--format must be csv or jsonl.');
  const rows = new Ledger(dataDir(d)).readEvidence();
  if (rows.length === 0) throw BUYERR.nothingToExport();
  if (format === 'jsonl') for (const r of rows) d.io.out(JSON.stringify(r));
  else {
    d.io.out(EVIDENCE_COLUMNS.join(','));
    for (const r of rows) d.io.out(EVIDENCE_COLUMNS.map((k) => csvCell(r[k])).join(','));
  }
  return 0;
}

