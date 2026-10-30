import { randomBytes } from 'node:crypto';
import {
  bytesToHex,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  parseSignature,
  type Address,
  type Hash,
  type Hex,
  type Transport,
} from 'viem';
import {
  DEPLOYMENTS,
  HEADER,
  deploymentForChainId,
  eip712Domain,
  livenessDigest,
  livenessFromJson,
  normalizeOrigin,
  originHash as hashOrigin,
  payerSigMessage,
  recoverDigestSigner,
  requestHash as hashRequest,
  GATEWAY_ERRORS,
  type Deployment,
  type PinnedAsset,
} from '@attessa/core';
import { EIP3009_TYPES, ENDPOINT_STATUS, tokenAbi } from './abi.ts';
import { Chain, RpcError, type Settlement } from './chain.ts';
import { Ledger, isTerminal } from './ledger.ts';
import {
  decodePaymentRequired,
  decodePaymentResponse,
  encodePaymentSignature,
  parseErrorBody,
  selectRequirement,
  signAuthorization,
  type Authorization,
} from './x402.ts';
import { verifyPaid, type VerifyResult } from './verify.ts';
import type {
  AssetKey,
  AttestConfig,
  CallCode,
  CallResult,
  ClientOptions,
  EvidenceRow,
  ExecutionProof,
  LedgerState,
  LivenessResult,
  Outcome,
  PendingEntry,
  ProofCheck,
  ResolvedEndpoint,
  StatusReport,
} from './types.ts';

/** V8: `validAfter = chainNow − 60`, `validBefore = chainNow + 120`. */
export const VALID_AFTER_BACK = 60n;
export const VALID_WINDOW = 120n;
/** "not charged" only from a block with timestamp > validBefore + 5 (INV-20). */
export const EXPIRY_MARGIN = 5n;
/** V9: 202 polling ends at validBefore + 60. */
export const POLL_UNTIL = 60n;
export const POLL_MS = 3000;
/** V0: how long to wait for another process's `reserved` entry to become `signed`. */
export const RESERVED_WAIT_MS = 30_000;

const DEFAULT_RPC: Record<'celo' | 'celo-sepolia', string> = {
  celo: 'https://forno.celo.org',
  'celo-sepolia': 'https://forno.celo-sepolia.celo-testnet.org',
};

/** Thrown by `cancelAuthorization` when the authorization was already used (FLOWS §8 `already_used`). */
export class AlreadyUsedError extends Error {
  readonly tx: Hash | undefined;
  constructor(tx: Hash | undefined) {
    super(`authorization already used${tx ? ` in ${tx}` : ''}`);
    this.name = 'AlreadyUsedError';
    this.tx = tx;
  }
}

/** A V1-V7 refusal: nothing was signed. `payAndVerify` returns it as `stopped`; `resolveEndpoint` and `checkLiveness` throw it. */
export class AttestError extends Error {
  readonly code: CallCode;
  readonly detail: string | undefined;
  constructor(code: CallCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

interface Net {
  chain: Chain;
  chainId: number;
  deployment: Deployment;
  registry: Address;
  x402Network: string;
}

const lc = <T extends string>(s: T) => s.toLowerCase() as T;
/** Ledger `code`: `code` or `code{detail}`, as SPEC §9 writes `proof_rejected{check}`. */
const codeString = (code: string, detail?: string) => (detail ? `${code}{${detail}}` : code);
const parseCode = (s: string) => s.split('{')[0] as CallCode;
const random32 = (): Hex => bytesToHex(randomBytes(32));

export function createAttestClient(cfg: AttestConfig, opts: ClientOptions = {}) {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const doFetch = opts.fetch ?? globalThis.fetch;
  const httpTimeout = opts.httpTimeoutMs ?? 60_000;
  const receiptWaitMs = opts.receiptWaitMs ?? 10_000;
  const waitForExpiry = cfg.waitForExpiry ?? true;
  const ledger = new Ledger(cfg.dataDir, now);
  const payer = lc(cfg.account.address);
  const transport: Transport =
    opts.transport ?? http(cfg.rpcUrl ?? (cfg.network === 'local' ? 'http://127.0.0.1:8545' : DEFAULT_RPC[cfg.network]));

  let netPromise: Promise<Net> | undefined;
  /** Chain id from the RPC; the deployment and pins for it (SPEC §2.6). */
  function net(): Promise<Net> {
    netPromise ??= (async () => {
      const probe = new Chain(transport, '0x0000000000000000000000000000000000000000');
      let chainId: number;
      try {
        chainId = await probe.chainId();
      } catch (e) {
        netPromise = undefined;
        throw new AttestError('rpc_unavailable', (e as Error).message);
      }
      let deployment: Deployment;
      if (cfg.network === 'local') {
        try {
          deployment = deploymentForChainId(chainId);
        } catch {
          throw new AttestError('network_mismatch', `no pinned deployment for chain ${chainId}`);
        }
      } else {
        deployment = DEPLOYMENTS[cfg.network];
        if (deployment.chainId !== chainId)
          throw new AttestError('network_mismatch', `RPC is on chain ${chainId}; ${cfg.network} is ${deployment.chainId}`);
      }
      const registry = opts.registry ?? deployment.enclaveRegistry;
      if (!registry) throw new Error(`no EnclaveRegistry is deployed for chain ${chainId}; pass options.registry`);
      return { chain: new Chain(transport, lc(registry)), chainId, deployment, registry: lc(registry), x402Network: deployment.x402Network };
    })();
    return netPromise;
  }

  function pinFor(n: Net, key: AssetKey): PinnedAsset {
    const pin = n.deployment.assets[key];
    if (!pin) throw new AttestError('network_mismatch', `${key} is not offered on chain ${n.chainId}`);
    return { ...pin, address: lc(pin.address) };
  }

  async function httpRequest(url: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), httpTimeout);
    try {
      return await doFetch(url, { ...init, signal: ctl.signal, redirect: 'manual' });
    } finally {
      clearTimeout(t);
    }
  }

  // ---------------------------------------------------------------- V1

  async function resolve(url: string): Promise<{ n: Net; ep: ResolvedEndpoint }> {
    const n = await net();
    const origin = normalizeOrigin(url, { local: cfg.network === 'local' });
    const oh = hashOrigin(origin);
    let e;
    try {
      e = await n.chain.endpoint(oh);
    } catch (err) {
      throw new AttestError('rpc_unavailable', (err as Error).message);
    }
    if (e.status === ENDPOINT_STATUS.None) throw new AttestError('endpoint_not_registered');
    if (e.status !== ENDPOINT_STATUS.Active) throw new AttestError('endpoint_retired');
    let wk: Record<string, unknown>;
    try {
      const res = await httpRequest(`${origin}/.well-known/attested-exec.json`, { method: 'GET' });
      wk = (await res.json()) as Record<string, unknown>;
      if (!res.ok || typeof wk !== 'object' || wk === null) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      throw new AttestError('origin_agent_mismatch', `.well-known unreadable: ${(err as Error).message}`);
    }
    if (wk.agentId !== e.agentId.toString())
      throw new AttestError('origin_agent_mismatch', `.well-known says agent ${String(wk.agentId)}, registry says ${e.agentId}`);
    if (typeof wk.registry !== 'string' || lc(wk.registry) !== n.registry) throw new AttestError('origin_agent_mismatch', '.well-known registry differs');
    if (wk.chainId !== String(n.chainId)) throw new AttestError('origin_agent_mismatch', '.well-known chainId differs');
    const selfVerifiedOwner = await n.chain.selfVerifiedOwner(e.agentId);
    return {
      n,
      ep: {
        origin,
        originHash: oh,
        chainId: n.chainId,
        registry: n.registry,
        agentId: e.agentId,
        payTo: e.payTo,
        operator: e.operator,
        selfVerifiedOwner,
      },
    };
  }

  // ---------------------------------------------------------------- V7

  /** Verifies a liveness object `{liveness:{…strings…},signature}`. Returns the failure reason, or the signer. */
  async function verifyLiveness(
    n: Net,
    ep: ResolvedEndpoint,
    obj: unknown,
    challenge: Hex,
  ): Promise<{ ok: true; signer: Address; releaseId: Hex; issuedAt: bigint } | { ok: false; reason: string }> {
    if (typeof obj !== 'object' || obj === null) return { ok: false, reason: 'missing' };
    const o = obj as { liveness?: unknown; signature?: unknown; signer?: unknown };
    let l;
    try {
      l = livenessFromJson(o.liveness);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (typeof o.signature !== 'string') return { ok: false, reason: 'malformed' };
    const r = await recoverDigestSigner(livenessDigest(eip712Domain(BigInt(n.chainId), n.registry), l), o.signature);
    if (r === null) return { ok: false, reason: 'bad_signature' };
    if (o.signer !== undefined && (typeof o.signer !== 'string' || lc(o.signer) !== r)) return { ok: false, reason: 'bad_signature' };
    if (l.challenge !== challenge) return { ok: false, reason: 'challenge_mismatch' };
    if (l.originHash !== ep.originHash) return { ok: false, reason: 'endpoint_mismatch' };
    if (l.agentId !== ep.agentId) return { ok: false, reason: 'agent_mismatch' };
    const [cs, head] = await Promise.all([n.chain.checkSigner(r, ep.originHash), n.chain.latest()]);
    if (cs.code !== 'OK') return { ok: false, reason: cs.code.toLowerCase() };
    if (l.releaseId !== cs.signer.releaseId) return { ok: false, reason: 'release_not_approved' };
    const skew = l.issuedAt > head.timestamp ? l.issuedAt - head.timestamp : head.timestamp - l.issuedAt;
    if (skew > 120n) return { ok: false, reason: 'clock_skew' };
    return { ok: true, signer: r, releaseId: l.releaseId, issuedAt: l.issuedAt };
  }

  // ---------------------------------------------------------------- results, settlement, evidence

  interface CallMeta {
    signer?: Address;
    releaseId?: Hex;
    ownerClaimedSource?: string;
    selfVerifiedOwner?: boolean;
  }

  function evidence(entry: PendingEntry, r: CallResult, extra: { responseHash?: Hex; inputsHash?: Hex; inputsBlock?: bigint; releaseId?: Hex } = {}) {
    const row: EvidenceRow = {
      v: '1',
      ts: String(Math.floor(now() / 1000)),
      requestId: entry.requestId,
      origin: entry.origin,
      agentId: entry.agentId,
      outcome: r.outcome,
      code: r.code ?? null,
      check: r.check ?? null,
      amount: entry.amount,
      asset: entry.asset,
      payTo: entry.payTo,
      settlementTx: r.settlementTx ?? entry.settlementTx ?? null,
      signer: r.signer ?? null,
      releaseId: extra.releaseId ?? r.proof?.releaseId ?? null,
      ownerClaimedSource: r.ownerClaimedSource ?? null,
      selfVerifiedOwner: r.selfVerifiedOwner ?? null,
      requestHash: entry.requestHash,
      responseHash: extra.responseHash ?? null,
      inputsHash: extra.inputsHash ?? null,
      inputsBlock: extra.inputsBlock === undefined ? null : extra.inputsBlock.toString(),
      inputsChecked: r.inputsChecked ?? null,
      via: 'gateway',
    };
    ledger.appendEvidence(row);
  }

  function baseResult(entry: PendingEntry, outcome: Outcome, meta: CallMeta = {}): CallResult {
    const r: CallResult = {
      outcome,
      requestId: entry.requestId,
      amount: BigInt(entry.amount),
      asset: entry.asset,
      payTo: entry.payTo,
    };
    if (entry.settlementTx) r.settlementTx = entry.settlementTx;
    if (meta.signer) r.signer = meta.signer;
    if (meta.ownerClaimedSource !== undefined) r.ownerClaimedSource = meta.ownerClaimedSource;
    if (meta.selfVerifiedOwner !== undefined) r.selfVerifiedOwner = meta.selfVerifiedOwner;
    return r;
  }

  /** V12 (and every other end state): ledger entry to `state`, evidence row, result. */
  function finish(
    entry: PendingEntry,
    outcome: Outcome,
    meta: CallMeta,
    fields: Partial<CallResult> = {},
    ev: { responseHash?: Hex; inputsHash?: Hex; inputsBlock?: bigint } = {},
  ): CallResult {
    const ledgerState: LedgerState | undefined =
      outcome === 'verified' || outcome === 'not_charged' || outcome === 'paid_but_rejected' || outcome === 'settled_after_refusal'
        ? outcome
        : outcome === 'refused' || outcome === 'uncertain'
          ? outcome
          : undefined;
    let e = entry;
    if (ledgerState && ledger.get(entry.requestId)) {
      e = ledger.update(entry.requestId, {
        state: ledgerState,
        code: fields.code ? codeString(fields.code, fields.detail ?? fields.check) : entry.code,
        ...(fields.settlementTx ? { settlementTx: fields.settlementTx } : {}),
      });
    }
    const r = { ...baseResult(e, outcome, meta), ...fields };
    evidence(e, r, { ...ev, ...(meta.releaseId ? { releaseId: meta.releaseId } : {}) });
    return r;
  }

  /** V11: the receipt at `tx` holds both logs from the pinned asset. Polls up to `receiptWaitMs` for a lagging RPC. */
  async function confirmSettlement(n: Net, entry: PendingEntry, tx: Hash): Promise<Settlement | null> {
    const tries = Math.max(1, Math.ceil(receiptWaitMs / 1000));
    for (let i = 1; ; i++) {
      const s = await n.chain.settlementIn(tx, entry.asset, entry.payer, entry.payTo, BigInt(entry.amount), entry.nonce!);
      if (s || i >= tries) return s;
      await sleep(1000);
    }
  }

  /** The settlement tx for an entry, from the chain: an `AuthorizationUsed` whose receipt also has the Transfer. */
  async function findSettlement(n: Net, entry: PendingEntry): Promise<Settlement | null> {
    const head = await n.chain.latest();
    const from = entry.signedAtBlock ? BigInt(entry.signedAtBlock) : head.number > 1000n ? head.number - 1000n : 0n;
    const logs = await n.chain.authorizationLogs(entry.asset, entry.payer, entry.nonce!, from, head.number);
    for (const tx of logs.used) {
      const s = await n.chain.settlementIn(tx, entry.asset, entry.payer, entry.payTo, BigInt(entry.amount), entry.nonce!);
      if (s) return s;
    }
    return null;
  }

  /** V11 then V10 on a delivered result, and the end state. */
  async function settleAndVerify(
    n: Net,
    entry: PendingEntry,
    response: Uint8Array,
    proofHeader: string | null,
    paymentResponse: string | null,
    meta: CallMeta,
    known?: Settlement,
  ): Promise<CallResult> {
    let settlement: Settlement | null = known ?? null;
    try {
      if (!settlement) {
        const pr = decodePaymentResponse(paymentResponse);
        const tx = pr?.success && pr.transaction ? pr.transaction : entry.settlementTx;
        if (tx) settlement = await confirmSettlement(n, entry, tx);
        if (!settlement) settlement = await findSettlement(n, entry);
      }
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      return finish(entry, 'uncertain', meta, { code: 'rpc_unavailable' });
    }
    if (!settlement) return finish(entry, 'uncertain', meta, {});
    entry = ledger.update(entry.requestId, { settlementTx: settlement.tx });

    let v: VerifyResult;
    try {
      v = await verifyPaid(n.chain, n.chainId, entry, response, proofHeader, settlement, sleep);
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      return finish(entry, 'uncertain', meta, { code: 'rpc_unavailable', settlementTx: settlement.tx });
    }
    const source =
      meta.ownerClaimedSource ?? (v.proof ? await n.chain.sourceRef(v.proof.agentId, v.proof.releaseId) : undefined);
    const m: CallMeta = { ...meta, ...(source !== undefined ? { ownerClaimedSource: source } : {}) };
    if (v.ok) {
      return finish(
        entry,
        'verified',
        { ...m, signer: v.signer, releaseId: v.proof.releaseId },
        { settlementTx: settlement.tx, response, proof: v.proof, signer: v.signer, inputsChecked: v.inputsChecked },
        { responseHash: v.responseHash, inputsHash: v.inputsHash, inputsBlock: v.inputsBlock },
      );
    }
    const f: Partial<CallResult> = { code: 'proof_rejected', check: v.check, settlementTx: settlement.tx, response };
    if (v.proof) f.proof = v.proof;
    if (v.signer) f.signer = v.signer;
    return finish(entry, 'paid_but_rejected', { ...m, ...(v.signer ? { signer: v.signer } : {}) }, f);
  }

  type Fetched =
    | { kind: 'result'; response: Uint8Array; proofHeader: string | null; paymentResponse: string | null }
    | { kind: 'pending' }
    | { kind: 'none'; status: number }
    | { kind: 'error' };

  /** `GET /v1/results/:requestId` with `X-Attest-Payer-Sig` over chain time. */
  async function fetchResult(n: Net, entry: PendingEntry): Promise<Fetched> {
    try {
      const ts = Number((await n.chain.latest()).timestamp);
      const sig = await cfg.account.signMessage({ message: payerSigMessage(entry.requestId, ts) });
      const res = await httpRequest(`${entry.origin}/v1/results/${entry.requestId}`, {
        method: 'GET',
        headers: { [HEADER.payerSig]: `${ts}.${sig}` },
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.status === 200)
        return {
          kind: 'result',
          response: bytes,
          proofHeader: res.headers.get(HEADER.attestedProof),
          paymentResponse: res.headers.get(HEADER.paymentResponse),
        };
      if (res.status === 202) return { kind: 'pending' };
      // Only the gateway's own §10 404 says there is no result. A proxy page or a 5xx says nothing.
      const err = parseErrorBody(new TextDecoder().decode(bytes));
      if (res.status === 404 && err?.error === 'result_not_found' && err.requestId === entry.requestId) return { kind: 'none', status: res.status };
      return { kind: 'error' };
    } catch {
      return { kind: 'error' };
    }
  }

  /**
   * The authorization was used on chain (`settlement`). First call getResult (INV-23): a result
   * that passes V10 → verified, one that fails → paid_but_rejected, none → settled_after_refusal
   * for a refused call or paid_but_rejected{missing_proof} for an uncertain one. "None" is the
   * gateway's `result_not_found`: while /v1/results is unreachable an uncertain call stays
   * `uncertain` (settlement recorded), so getResult / reconcilePending can still verify it (INV-13).
   */
  async function settledPath(n: Net, entry: PendingEntry, settlement: Settlement, meta: CallMeta): Promise<CallResult> {
    entry = ledger.update(entry.requestId, { settlementTx: settlement.tx });
    let noResult = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const f = await fetchResult(n, entry);
      if (f.kind === 'result') return settleAndVerify(n, entry, f.response, f.proofHeader, f.paymentResponse, meta, settlement);
      if (f.kind === 'none') {
        noResult = true;
        break;
      }
      await sleep(POLL_MS);
    }
    if (entry.state === 'refused') {
      const f: Partial<CallResult> = { settlementTx: settlement.tx };
      if (entry.code) f.code = parseCode(entry.code);
      return finish(entry, 'settled_after_refusal', meta, f);
    }
    if (!noResult) return finish(entry, 'uncertain', meta, { settlementTx: settlement.tx });
    return finish(entry, 'paid_but_rejected', meta, { code: 'proof_rejected', check: 'missing_proof', settlementTx: settlement.tx });
  }

  /**
   * `refused` / `uncertain` → final (SPEC §7). Chain evidence only: `AuthorizationUsed` + Transfer →
   * the settled path; `AuthorizationCanceled` → not_charged; otherwise wait for a block with
   * timestamp > validBefore + 5 and read `authorizationState` there (INV-20). With `wait` false,
   * one pass and the current state if nothing is decided yet.
   */
  async function finalize(n: Net, entry: PendingEntry, meta: CallMeta, wait: boolean): Promise<CallResult> {
    const vb = BigInt(entry.validBefore!);
    let lagging = 0;
    for (;;) {
      try {
        const head = await n.chain.latest();
        const from = BigInt(entry.signedAtBlock ?? '0');
        const logs = await n.chain.authorizationLogs(entry.asset, entry.payer, entry.nonce!, from, head.number);
        for (const tx of logs.used) {
          const s = await n.chain.settlementIn(tx, entry.asset, entry.payer, entry.payTo, BigInt(entry.amount), entry.nonce!);
          if (s) return settledPath(n, entry, s, meta);
        }
        if (logs.canceled.length > 0) {
          return finish(entry, 'not_charged', meta, { code: 'cancelled', confirmedAtBlock: head.number });
        }
        if (head.timestamp > vb + EXPIRY_MARGIN) {
          const used = await n.chain.authorizationState(entry.asset, entry.payer, entry.nonce!, head.number);
          if (!used) return finish(entry, 'not_charged', meta, { confirmedAtBlock: head.number });
          // Used, but no matching log yet: the log index lags. Ask again.
          if (++lagging > 20) return current(entry, meta);
        }
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
        if (!wait) return current(entry, meta, 'rpc_unavailable');
      }
      if (!wait) return current(entry, meta);
      await sleep(POLL_MS);
    }
  }

  function current(entry: PendingEntry, meta: CallMeta, code?: CallCode): CallResult {
    const e = ledger.get(entry.requestId) ?? entry;
    const outcome: Outcome = e.state === 'refused' ? 'refused' : isTerminal(e) ? (e.state as Outcome) : 'uncertain';
    const r = baseResult(e, outcome, meta);
    const c = code ?? (e.code ? parseCode(e.code) : undefined);
    if (c) r.code = c;
    // A paid_but_rejected entry keeps its check in `proof_rejected{check}` (INV-13: the specific ProofCheck).
    const check = e.state === 'paid_but_rejected' && e.code?.startsWith('proof_rejected{') ? e.code.slice('proof_rejected{'.length, -1) : undefined;
    if (check) r.check = check as ProofCheck;
    return r;
  }

  // ---------------------------------------------------------------- V9

  async function paidRequest(
    n: Net,
    entry: PendingEntry,
    url: string,
    body: Uint8Array,
    paymentSignature: string,
    meta: CallMeta,
  ): Promise<CallResult> {
    let res: Response;
    let bytes: Uint8Array;
    try {
      res = await httpRequest(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [HEADER.requestId]: entry.requestId,
          [HEADER.paymentSignature]: paymentSignature,
        },
        body: body as Uint8Array<ArrayBuffer>,
      });
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      return afterUnknown(n, entry, meta);
    }

    if (res.status === 200) {
      return settleAndVerify(n, entry, bytes, res.headers.get(HEADER.attestedProof), res.headers.get(HEADER.paymentResponse), meta);
    }
    if (res.status === 202) return pollResults(n, entry, meta);

    const err = parseErrorBody(new TextDecoder().decode(bytes));
    if (res.status === 409 && err?.error === 'in_progress' && err.requestId === entry.requestId) return pollResults(n, entry, meta);
    if (res.status >= 400 && err && err.requestId === entry.requestId && Object.hasOwn(GATEWAY_ERRORS, err.error)) {
      const code = err.error as CallCode;
      const e = ledger.update(entry.requestId, { state: 'refused', code: codeString(code, err.detail ?? undefined) });
      const r: Partial<CallResult> = { code };
      if (err.detail) r.detail = err.detail;
      if (!waitForExpiry) return finish(e, 'refused', meta, r);
      evidence(e, { ...baseResult(e, 'refused', meta), ...r });
      return finalize(n, e, meta, true);
    }
    // A proxy 502, an HTML page, a missing body: not a refusal (INV-23).
    return afterUnknown(n, entry, meta);
  }

  /** 202: poll `/v1/results` every 3 s until 200 or validBefore + 60, else uncertain. */
  async function pollResults(n: Net, entry: PendingEntry, meta: CallMeta): Promise<CallResult> {
    entry = ledger.update(entry.requestId, { state: 'settle_pending' });
    const limit = BigInt(entry.validBefore!) + POLL_UNTIL;
    for (;;) {
      const f = await fetchResult(n, entry);
      if (f.kind === 'result') return settleAndVerify(n, entry, f.response, f.proofHeader, f.paymentResponse, meta);
      let head;
      try {
        head = await n.chain.latest();
      } catch {
        head = undefined;
      }
      if (head && head.timestamp > limit) break;
      await sleep(POLL_MS);
    }
    return afterUnknown(n, entry, meta);
  }

  async function afterUnknown(n: Net, entry: PendingEntry, meta: CallMeta): Promise<CallResult> {
    const e = ledger.update(entry.requestId, { state: 'uncertain' });
    if (!waitForExpiry) return finish(e, 'uncertain', meta, {});
    return finalize(n, e, meta, true);
  }

  // ---------------------------------------------------------------- V0 resume

  async function resume(n: Net, entry: PendingEntry): Promise<CallResult | null> {
    if (entry.state === 'reserved') {
      for (let waited = 1000; ; waited += 1000) {
        await sleep(1000);
        const e = ledger.get(entry.requestId);
        if (!e) return null; // the other process released it: start afresh
        if (e.state !== 'reserved') {
          entry = e;
          break;
        }
        if (waited >= RESERVED_WAIT_MS) {
          const r: CallResult = { ...baseResult(e, 'stopped'), code: 'in_progress' };
          evidence(e, r); // SPEC §9: every outcome is in evidence
          return r;
        }
      }
    }
    if (isTerminal(entry)) return current(entry, {});
    const f = await fetchResult(n, entry);
    if (f.kind === 'result') return settleAndVerify(n, entry, f.response, f.proofHeader, f.paymentResponse, {});
    return finalize(n, entry, {}, waitForExpiry);
  }

  // ---------------------------------------------------------------- payAndVerify

  async function payAndVerify(
    url: string,
    req: { body: Uint8Array | string; requestId?: Hex; maxAmount?: bigint; asset?: AssetKey; newRequest?: boolean },
  ): Promise<CallResult> {
    const body = typeof req.body === 'string' ? new TextEncoder().encode(req.body) : req.body;
    const u = new URL(url);
    const pathAndQuery = `${u.pathname}${u.search}`;
    const assetKey = req.asset ?? cfg.asset;
    let requestId = lc(req.requestId ?? random32());
    // What is known so far, for the evidence row of a stopped call (SPEC §9: every outcome is in evidence).
    const known: { agentId?: bigint; amount?: bigint; asset?: Address; payTo?: Address; origin?: string; requestHash?: Hex } = {};
    const stopped = (code: CallCode, detail?: string): CallResult => {
      const r: CallResult = { outcome: 'stopped', code, requestId };
      if (detail) r.detail = detail;
      ledger.appendEvidence({
        v: '1', ts: String(Math.floor(now() / 1000)), requestId, origin: known.origin ?? url, agentId: known.agentId?.toString() ?? null,
        outcome: 'stopped', code, check: null, amount: known.amount?.toString() ?? null, asset: known.asset ?? null,
        payTo: known.payTo ?? null, settlementTx: null, signer: null, releaseId: null, ownerClaimedSource: null, selfVerifiedOwner: null,
        requestHash: known.requestHash ?? null, responseHash: null, inputsHash: null, inputsBlock: null, inputsChecked: null, via: 'gateway',
      });
      return r;
    };

    let n: Net;
    let ep: ResolvedEndpoint;
    const origin = normalizeOrigin(url, { local: cfg.network === 'local' });
    const rh = hashRequest('POST', pathAndQuery, body);
    known.origin = origin;
    known.requestHash = rh;
    try {
      n = await net();
      // V0
      const oh = hashOrigin(origin);
      if (!req.newRequest) {
        const open = ledger.list().find((e) => e.originHash === oh && e.requestHash === rh && !isTerminal(e));
        if (open) {
          const resumed = await resume(n, open);
          if (resumed) return resumed;
        }
      }
      if (req.requestId && ledger.get(requestId)) return stopped('request_id_conflict', 'requestId already in the ledger');
      // V1
      ({ ep } = await resolve(url));
      known.agentId = ep.agentId;
    } catch (e) {
      if (e instanceof AttestError) return stopped(e.code, e.detail);
      throw e;
    }

    // V2
    const challenge = random32();
    let pr;
    try {
      const res = await httpRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [HEADER.requestId]: requestId, [HEADER.challenge]: challenge },
        body: body as Uint8Array<ArrayBuffer>,
      });
      const text = await res.text();
      if (res.status !== 402) {
        const err = parseErrorBody(text);
        if (err && (err.error === 'gateway_paused' || err.error === 'bad_request' || err.error === 'rate_limited' || err.error === 'gateway_busy'))
          return stopped(err.error, err.detail ?? undefined);
        return stopped('quote_unavailable', `HTTP ${res.status}`);
      }
      pr = decodePaymentRequired(res.headers.get(HEADER.paymentRequired));
      if (!pr) return stopped('quote_malformed', 'PAYMENT-REQUIRED is not an x402 v2 PaymentRequired');
    } catch (e) {
      return stopped('quote_unavailable', (e as Error).message);
    }

    // V3
    let pin: PinnedAsset;
    try {
      pin = pinFor(n, assetKey);
    } catch (e) {
      if (e instanceof AttestError) return stopped(e.code, e.detail);
      throw e;
    }
    const sel = selectRequirement(pr, { network: n.x402Network, pin, chainId: n.chainId, registry: n.registry, agentId: ep.agentId });
    if (!sel.ok) return stopped(sel.code, sel.detail);
    const accepted = sel.entry;
    const amount = BigInt(accepted.amount);
    known.amount = amount;
    known.asset = pin.address;
    known.payTo = lc(accepted.payTo as Address);

    // V4
    if (lc(accepted.payTo) !== ep.payTo) return stopped('payto_mismatch', `quote payTo ${lc(accepted.payTo)}, registry payTo ${ep.payTo}`);

    // V5
    const limits = cfg.limits[assetKey];
    const max = req.maxAmount !== undefined && req.maxAmount < limits.maxAmountPerCall ? req.maxAmount : limits.maxAmountPerCall;
    if (amount > max) return stopped('over_max_amount', `price ${amount}, max ${max}`);

    // V6: reservation and ledger entry are one record.
    const entry: PendingEntry = {
      v: '1',
      requestId,
      origin: ep.origin,
      originHash: ep.originHash,
      method: 'POST',
      pathAndQuery,
      requestHash: rh,
      asset: pin.address,
      amount: amount.toString(),
      payTo: ep.payTo,
      payer,
      nonce: null,
      signedAtChain: null,
      signedAtBlock: null,
      validAfter: null,
      validBefore: null,
      agentId: ep.agentId.toString(),
      expectedSigner: null,
      state: 'reserved',
      code: null,
      settlementTx: null,
      createdAt: String(now()),
    };
    for (let attempt = 0; ; attempt++) {
      const got = ledger.reserve(entry, limits.dailyCap, { resumeOpen: req.newRequest !== true });
      if (got === 'reserved') break;
      if (got === 'over_daily_cap') return stopped('over_daily_cap');
      if (got === 'request_id_conflict') return stopped('request_id_conflict', 'requestId already in the ledger');
      // V0 again, under the lock: another process opened the same input after our first V0 check.
      const resumed = await resume(n, got.open);
      if (resumed) return resumed;
      if (attempt >= 2) return stopped('in_progress', 'the same request kept starting in another process');
    }

    // V7
    let live;
    try {
      live = await verifyLiveness(n, ep, sel.liveness, challenge);
    } catch (e) {
      ledger.removeIfUnchanged(entry);
      if (e instanceof RpcError) return stopped('rpc_unavailable', e.message);
      throw e;
    }
    if (!live.ok) {
      ledger.removeIfUnchanged(entry);
      return stopped('liveness_failed', live.reason);
    }
    const meta: CallMeta = { selfVerifiedOwner: ep.selfVerifiedOwner, releaseId: live.releaseId };
    const source = await n.chain.sourceRef(ep.agentId, live.releaseId);
    if (source !== undefined) meta.ownerClaimedSource = source;

    // V8: the window comes from chain time, never the local clock.
    let head;
    try {
      head = await n.chain.latest();
    } catch (e) {
      ledger.removeIfUnchanged(entry);
      return stopped('rpc_unavailable', (e as Error).message);
    }
    const auth: Authorization = {
      from: payer,
      to: ep.payTo,
      value: amount.toString(),
      validAfter: (head.timestamp - VALID_AFTER_BACK).toString(),
      validBefore: (head.timestamp + VALID_WINDOW).toString(),
      nonce: random32(),
    };
    // Only our own reservation turns `signed`. If V7 stalled past the 10-minute sweep, the entry was
    // dropped and the requestId may now belong to another call (INV-14): sign nothing.
    const signed = ledger.updateIfUnchanged(entry, {
      state: 'signed',
      nonce: auth.nonce,
      signedAtChain: head.timestamp.toString(),
      signedAtBlock: head.number.toString(),
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      expectedSigner: live.signer,
    });
    if (!signed) {
      if (ledger.get(requestId)) return stopped('request_id_conflict', 'requestId was taken by another call while this one waited');
      return stopped('liveness_failed', 'reservation_expired');
    }
    let signature: Hex;
    try {
      signature = await signAuthorization(cfg.account, n.chainId, pin, auth);
    } catch (e) {
      // Nothing left the process: release the reservation.
      ledger.removeIfUnchanged(signed);
      throw e;
    }

    // V9 → V11 → V10 → V12
    return paidRequest(n, signed, url, body, encodePaymentSignature(pr, accepted, auth, signature), meta);
  }

  // ---------------------------------------------------------------- public API

  async function entryOf(requestId: Hex): Promise<PendingEntry> {
    const e = ledger.get(requestId);
    if (!e) throw new Error(`no pending ledger entry for ${requestId}`);
    return e;
  }

  return {
    async resolveEndpoint(url: string): Promise<ResolvedEndpoint> {
      return (await resolve(url)).ep;
    },

    async checkLiveness(url: string): Promise<LivenessResult> {
      const { n, ep } = await resolve(url);
      const challenge = random32();
      const t0 = now();
      let obj: unknown;
      try {
        const res = await httpRequest(`${ep.origin}/v1/liveness`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ challenge }),
        });
        obj = await res.json();
      } catch (e) {
        return { ok: false, reason: `unreachable: ${(e as Error).message}` };
      }
      const latencyMs = now() - t0;
      const v = await verifyLiveness(n, ep, obj, challenge);
      return v.ok ? { ok: true, signer: v.signer, releaseId: v.releaseId, issuedAt: v.issuedAt, latencyMs } : { ok: false, reason: v.reason, latencyMs };
    },

    payAndVerify,

    /** V10 on a delivered result, anchored at the entry's signing time and its settlement (which must be on chain). */
    async verifyPaidResponse(
      entry: PendingEntry,
      response: Uint8Array,
      proofHeader: string,
    ): Promise<{ ok: true; proof: ExecutionProof; signer: Address } | { ok: false; check: ProofCheck }> {
      const n = await net();
      const s = entry.settlementTx ? await confirmSettlement(n, entry, entry.settlementTx) : await findSettlement(n, entry);
      if (!s) throw new Error(`no settlement on chain for ${entry.requestId}`);
      const v = await verifyPaid(n.chain, n.chainId, entry, response, proofHeader, s, sleep);
      return v.ok ? { ok: true, proof: v.proof, signer: v.signer } : { ok: false, check: v.check };
    },

    /** Fetches and verifies a stored result. Never re-pays. */
    async getResult(requestId: Hex): Promise<CallResult> {
      const n = await net();
      const entry = await entryOf(lc(requestId));
      if (entry.nonce === null) return { ...baseResult(entry, 'stopped'), code: 'missing_nonce' };
      const f = await fetchResult(n, entry);
      if (f.kind === 'result') {
        if (isTerminal(entry) && entry.state !== 'verified') return current(entry, {});
        return settleAndVerify(n, entry, f.response, f.proofHeader, f.paymentResponse, {});
      }
      const r = current(entry, {});
      r.code = f.kind === 'pending' ? 'settle_pending' : f.kind === 'none' ? 'result_not_found' : 'rpc_unavailable';
      return r;
    },

    /** Waits until chain time > validBefore + 5, then decides from chain state (INV-20). */
    async confirmNotCharged(requestId: Hex): Promise<CallResult> {
      const n = await net();
      const entry = await entryOf(lc(requestId));
      if (entry.nonce === null) return { ...baseResult(entry, 'stopped'), code: 'missing_nonce' };
      if (isTerminal(entry)) return current(entry, {});
      return finalize(n, entry, {}, true);
    },

    /** EIP-3009 `cancelAuthorization` from the payer's wallet. `not_charged` once the cancel is confirmed. */
    async cancelAuthorization(requestId: Hex): Promise<Hash> {
      const n = await net();
      const entry = await entryOf(lc(requestId));
      if (entry.nonce === null) throw new Error('nothing was signed for this request');
      const head = await n.chain.latest();
      const logs = await n.chain.authorizationLogs(entry.asset, entry.payer, entry.nonce, BigInt(entry.signedAtBlock ?? '0'), head.number);
      if (logs.canceled.length > 0) return logs.canceled[0]!;
      if (logs.used.length > 0 || (await n.chain.authorizationState(entry.asset, entry.payer, entry.nonce, head.number)))
        throw new AlreadyUsedError(logs.used[0]);
      const pin = Object.values(n.deployment.assets).find((a) => lc(a.address) === entry.asset);
      if (!pin) throw new Error(`asset ${entry.asset} is not pinned on chain ${n.chainId}`);
      if (!cfg.account.signTypedData) throw new Error('account cannot sign typed data');
      const sig = await cfg.account.signTypedData({
        domain: { name: pin.name, version: pin.version, chainId: n.chainId, verifyingContract: entry.asset },
        types: { CancelAuthorization: EIP3009_TYPES.CancelAuthorization },
        primaryType: 'CancelAuthorization',
        message: { authorizer: entry.payer, nonce: entry.nonce },
      });
      const { r, s, v, yParity } = parseSignature(sig);
      const chain = defineChain({
        id: n.chainId,
        name: `chain-${n.chainId}`,
        nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
        rpcUrls: { default: { http: [] } },
      });
      const wallet = createWalletClient({ account: cfg.account, chain, transport });
      const hash = await wallet.writeContract({
        address: entry.asset,
        abi: tokenAbi,
        functionName: 'cancelAuthorization',
        args: [entry.payer, entry.nonce, Number(v ?? BigInt(yParity + 27)), r, s],
      });
      const receipt = await n.chain.client.waitForTransactionReceipt({ hash, pollingInterval: 1000 });
      const canceled = parseEventLogs({ abi: tokenAbi, logs: receipt.logs.filter((l) => lc(l.address) === entry.asset), eventName: 'AuthorizationCanceled' }).some(
        (ev) => lc(ev.args.authorizer) === entry.payer && lc(ev.args.nonce) === entry.nonce,
      );
      if (receipt.status !== 'success' || !canceled) {
        const found = await findSettlement(n, entry);
        throw new AlreadyUsedError(found?.tx);
      }
      finish(entry, 'not_charged', {}, { code: 'cancelled', confirmedAtBlock: receipt.blockNumber });
      return hash;
    },

    async listPending(): Promise<PendingEntry[]> {
      return ledger.list().filter((e) => !isTerminal(e));
    },

    /** Drives every open entry to an end state (waits for expiry when `waitForExpiry`). Drops unsigned reservations older than 10 minutes. */
    async reconcilePending(): Promise<CallResult[]> {
      const n = await net();
      ledger.withLock((entries) => ({
        entries: entries.filter((e) => !(e.state === 'reserved' && e.nonce === null && now() - Number(e.createdAt) > 10 * 60 * 1000)),
        result: undefined,
      }));
      const out: CallResult[] = [];
      for (const e of ledger.list()) {
        if (isTerminal(e) || e.nonce === null) continue;
        if (e.state !== 'refused') {
          const f = await fetchResult(n, e);
          if (f.kind === 'result') {
            out.push(await settleAndVerify(n, e, f.response, f.proofHeader, f.paymentResponse, {}));
            continue;
          }
        }
        out.push(await finalize(n, e, {}, waitForExpiry));
      }
      return out;
    },

    async status(target: string | bigint): Promise<StatusReport> {
      const pending = ledger.list().filter((e) => !isTerminal(e));
      if (typeof target === 'bigint') return { agentId: target, pending: pending.filter((e) => e.agentId === target.toString()) };
      const n = await net();
      const origin = normalizeOrigin(target, { local: cfg.network === 'local' });
      const oh = hashOrigin(origin);
      const e = await n.chain.endpoint(oh);
      const status = e.status === ENDPOINT_STATUS.Active ? 'active' : e.status === ENDPOINT_STATUS.Retired ? 'retired' : 'none';
      return {
        origin,
        originHash: oh,
        agentId: e.agentId,
        endpoint: { status, payTo: e.payTo, operator: e.operator },
        pending: pending.filter((p) => p.originHash === oh),
      };
    },

    /** The ledger, for the CLI (`attessa status --pending`, `attessa evidence export`). */
    ledger,
  };
}

export type AttestClient = ReturnType<typeof createAttestClient>;
