import { resolve } from 'node:path';
import { decodeAttestedProof, deploymentForChainId, eip712Domain, proofDigest, recoverDigestSigner, responseHash, DEPLOYMENTS, type Deployment, type ExecutionProof } from '@attessa/core';
import { Chain, Ledger, RELEASE_STATUS, RpcError, verifyPaid, type PendingEntry, type Settlement } from '@attessa/sdk';
import { http, parseEventLogs, parseAbi, type Address, type Hex } from 'viem';
import { DEFAULT_RPC, type Deps, type Global } from '../context.ts';
import { CliError, ERR, checkWords, rpcShownSafe, safe, short } from '../copy.ts';
import { dataDir, display } from './buyer.ts';

/**
 * `attessa verify <requestId|settlement tx>` (T21a, FLOWS agent tool `verify_proof`). Read-only: it never loads a key
 * (no wallet, no keychain, no ATTESSA_PRIVATE_KEY), signs nothing and pays nothing. It re-checks one past call from
 * public Celo data and the proof the buyer kept. All crypto is @attessa/core's, all chain reads are the SDK's `Chain`.
 */

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const lc = (s: string) => s.toLowerCase();

export type CheckId = 'release' | 'signer' | 'signature' | 'binding' | 'timing_and_inputs' | 'settlement';
export type CheckStatus = 'pass' | 'fail' | 'not_checked';
export interface CheckRow {
  check: CheckId;
  status: CheckStatus;
  detail: string;
  /** Celoscan page for this check; null on a local chain, which has no explorer. */
  link: string | null;
}

const EXPLORER: Record<number, string> = { 11142220: 'https://sepolia.celoscan.io', 42220: 'https://celoscan.io' }; // not in FLOWS

const RPC_OLD = "Can't finish checking: your RPC doesn't have that block's data. Retry with --rpc <archive RPC>."; // SPEC §7 V10 wording

const tokenLogs = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/** What the settlement check needs, from the ledger entry or (tx form) read off the transaction itself. */
interface Payment {
  asset: Address;
  payer: Address;
  payTo: Address;
  amount: bigint;
  nonce: Hex;
}

function rpcFor(g: Global, d: Deps): string {
  if (g.rpc) return g.rpc;
  if (g.network === 'local') throw ERR.usage('--network local needs --rpc.');
  return DEFAULT_RPC[g.network];
}

/** `--response` is a file. The value is never echoed back: it may be a URL or path holding a credential (SPEC §7 "Never printed"). */
function readFileArg(d: Deps, flag: string, value: string): Buffer {
  try {
    return d.readFile(resolve(d.cwd, value));
  } catch {
    throw ERR.usage(`Can't read the file given to ${flag}.`); // not in FLOWS
  }
}

function proofHeaderOf(d: Deps, value: string): string {
  let text: string | undefined;
  try {
    text = d.readFile(resolve(d.cwd, value)).toString('utf8');
  } catch {
    text = undefined;
  }
  const header = (text ?? value).trim();
  if (!BASE64.test(header)) throw ERR.usage("--proof must be a file holding the X-Attested-Proof header, or the header itself.");
  return header;
}

export interface VerifyOpts {
  target?: string | undefined;
  proof?: string | undefined;
  response?: string | undefined;
}

export async function verify(g: Global, d: Deps, o: VerifyOpts): Promise<number> {
  if (!o.target) throw ERR.usage('Usage: attessa verify <requestId|settlement tx> [--proof <file>] [--response <file>]');
  if (!HEX32.test(o.target)) throw ERR.usage('A requestId and a transaction hash are 0x followed by 64 hex characters.');
  const target = lc(o.target) as Hex;
  const proofHeader = o.proof === undefined ? undefined : proofHeaderOf(d, o.proof);
  const response = o.response === undefined ? undefined : new Uint8Array(readFileArg(d, '--response', o.response));

  // ---- the chain: read-only, from a public RPC
  const url = rpcFor(g, d);
  // not in FLOWS: §8's rpc row says "Nothing was signed.", which a read-only command has no use for.
  const unreachable = () => new CliError('rpc_unavailable', `Can't reach Celo at ${rpcShownSafe(url)}.`, 'Retry or set another `--rpc`.');
  const transport = d.sdk?.transport ?? http(url, { retryCount: 1, timeout: 20_000 });
  const probe = new Chain(transport, '0x0000000000000000000000000000000000000000');
  let chainId: number;
  try {
    chainId = await probe.chainId();
  } catch {
    throw unreachable();
  }
  let deployment: Deployment;
  if (g.network === 'local') {
    try {
      deployment = deploymentForChainId(chainId);
    } catch {
      throw ERR.usage(`Your RPC is on chain ${chainId}, which has no Attessa deployment.`);
    }
  } else {
    deployment = DEPLOYMENTS[g.network === 'mainnet' ? 'celo' : 'celo-sepolia'];
    if (chainId !== deployment.chainId) throw ERR.networkMismatch(chainId, deployment.chainId);
  }
  const registry = deployment.enclaveRegistry ?? d.env.ATTESSA_REGISTRY ?? null;
  if (!registry) throw ERR.noRegistry(g.network);
  if (!/^0x[0-9a-fA-F]{40}$/.test(registry)) throw ERR.usage('ATTESSA_REGISTRY must be an address.');
  const chain = new Chain(transport, lc(registry) as Address);
  // A local chain (even a fork that keeps Sepolia's chain id) has blocks and transactions no public explorer shows.
  const base = g.network === 'local' ? undefined : EXPLORER[chainId];
  const addr = (a: string) => (base ? `${base}/address/${a}` : null);
  const txLink = (t: string) => (base ? `${base}/tx/${t}` : null);

  try {
    return await run();
  } catch (e) {
    if (e instanceof RpcError) throw unreachable();
    throw e;
  }

  async function run(): Promise<number> {
    // ---- the local record
    const entries = new Ledger(dataDir(d)).list();
    const entry: PendingEntry | undefined = entries.find((e) => e.requestId === target) ?? entries.find((e) => e.settlementTx !== null && lc(e.settlementTx) === target);

    let payment: Payment | undefined;
    let known: Hex | null = null; // the settlement tx, once known
    let nonce: Hex | null = null;
    if (entry) {
      known = entry.settlementTx;
      if (entry.nonce) {
        payment = { asset: entry.asset, payer: entry.payer, payTo: entry.payTo, amount: BigInt(entry.amount), nonce: entry.nonce };
        nonce = entry.nonce;
      }
    } else {
      const found = await paymentInTx(chain, deployment, target);
      if (!found) {
        throw new CliError(
          'request_not_found',
          `No record of ${short(target)} in ${safe(display(d, dataDir(d)))}, and no Attessa payment in a transaction with that hash on ${g.network}.`,
          'Check the id, or pass the settlement transaction hash of the call.',
        );
      }
      payment = found;
      known = target;
      nonce = found.nonce;
    }

    // ---- settlement (V11): `settled` with the tx, or the authorization provably unspent after validBefore
    const rows: Partial<Record<CheckId, CheckRow>> = {};
    const set = (check: CheckId, status: CheckStatus, detail: string, link: string | null) => void (rows[check] = { check, status, detail, link });
    let settlement: Settlement | null = null;
    if (!payment) {
      set('settlement', 'fail', 'nothing was signed for this request, so there is no payment to find', null);
    } else {
      const s = await settle(payment, known, entry);
      settlement = s.settlement;
      set('settlement', s.status, s.detail, s.link);
    }

    // ---- the proof: stored by the buyer, never fetched from the gateway (that needs the buyer's key)
    let decoded: ReturnType<typeof decodeAttestedProof> | undefined;
    let proofWhy = proofHeader === undefined ? 'no proof given: pass --proof <file> with the X-Attested-Proof header you kept' : '';
    if (proofHeader !== undefined) {
      try {
        decoded = decodeAttestedProof(proofHeader);
      } catch {
        proofWhy = '';
        set('signature', 'fail', "the proof isn't a well-formed X-Attested-Proof", addr(chain.registry));
      }
    }
    const skipLink = (check: CheckId) => (check === 'binding' || check === 'timing_and_inputs') && known ? txLink(known) : addr(chain.registry);
    const skip = (check: CheckId, why: string) => void (rows[check] ??= { check, status: 'not_checked', detail: why, link: skipLink(check) });
    let recovered: Address | null = null;
    if (decoded) {
      const proof = decoded.proof;
      const domain = eip712Domain(BigInt(chainId), chain.registry);
      recovered = ((await recoverDigestSigner(proofDigest(domain, proof), decoded.signature)) ?? null) as Address | null;
      if (recovered !== null && recovered === lc(decoded.signer)) {
        set('signature', 'pass', `signed by ${short(recovered)}, the signer named in the proof`, addr(recovered));
      } else {
        set('signature', 'fail', recovered === null ? "the signature can't be recovered (malformed or high-s)" : `the proof is signed by ${short(recovered)}, not by the signer it names (${short(decoded.signer)})`, addr(chain.registry));
      }
      binding(proof);
      await status(proof, recovered, settlement, entry);
      await v10(settlement, entry);
    } else {
      for (const c of ['release', 'signer', 'signature', 'binding', 'timing_and_inputs'] as const) skip(c, proofWhy || 'the proof could not be read');
    }

    /** The SDK's own V10 (SPEC §7): every §6.2 step-9 check at the payment's time anchors. `verified` never stands on less. */
    async function v10(s: Settlement | null, e: PendingEntry | undefined): Promise<void> {
      const link = known ? txLink(known) : addr(chain.registry);
      const why = !e ? 'needs the local record of the call (its signing time and payment)' : !s ? 'needs the settlement: a call that was not charged has no paid answer to check' : response === undefined ? 'no answer given: pass --response <file>' : '';
      if (why) return set('timing_and_inputs', 'not_checked', why, link);
      try {
        const sleep = d.sdk?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        const r = await verifyPaid(chain, chainId, e!, response!, proofHeader!, s!, sleep);
        if (!r.ok) {
          const words = checkWords(r.check)?.[0] ?? safe(r.check);
          return set('timing_and_inputs', 'fail', `${words} (${safe(r.check)})`, link);
        }
        const note = r.inputsChecked ? '' : "; the account values were not re-read (your RPC doesn't keep state that old)"; // SPEC §7 V10: not a failure
        set('timing_and_inputs', 'pass', `expiry, time anchors, agent, inputs hash and the Celo data at block ${r.inputsBlock} all check out${note}`, link);
      } catch (err) {
        if (!(err instanceof RpcError)) throw err;
        set('timing_and_inputs', 'not_checked', RPC_OLD, link);
      }
    }

    function binding(proof: ExecutionProof): void {
      const link = known ? txLink(known) : addr(chain.registry);
      const bad: string[] = [];
      let unchecked = '';
      if (entry) {
        if (proof.requestId !== entry.requestId) bad.push("requestId isn't this call's");
        if (proof.requestHash !== entry.requestHash) bad.push("requestHash isn't this call's request");
      } else unchecked = 'requestId and requestHash need the local record of the call';
      if (nonce !== null && proof.paymentId !== nonce) bad.push("paymentId isn't this payment's authorization");
      if (response !== undefined) {
        if (proof.responseHash !== responseHash(response)) bad.push("responseHash doesn't match the answer you kept");
      } else unchecked = `${unchecked ? `${unchecked}; ` : ''}no answer given: pass --response <file>`;
      if (bad.length > 0) set('binding', 'fail', bad.join('; '), link);
      else if (unchecked) set('binding', 'not_checked', unchecked, link);
      else set('binding', 'pass', 'requestId, requestHash, responseHash and paymentId all match the call', link);
    }

    async function status(proof: ExecutionProof, signer: Address | null, s: Settlement | null, e: PendingEntry | undefined): Promise<void> {
      // The status that mattered is the one at the payment: the settlement block, else when the call was signed.
      const at: bigint | undefined = s ? s.blockNumber : e?.signedAtBlock ? BigInt(e.signedAtBlock) : undefined;
      const atTs = s ? s.timestamp : e?.signedAtChain ? BigInt(e.signedAtChain) : (await chain.latest()).timestamp;
      const when = s ? 'at its settlement' : 'when it was signed';
      const rel = `release ${short(proof.releaseId)} of agent ${proof.agentId}`;
      const relLink = addr(chain.registry);

      let relState: number | undefined;
      let signerCode: { code: string; agentId?: bigint | undefined; releaseId?: Hex | undefined } | undefined;
      let signerRpc = false;
      let releaseRpc = false;
      try {
        relState = await chain.releaseStatus(proof.agentId, proof.releaseId, at);
      } catch (err) {
        if (!(err instanceof RpcError)) throw err;
      }
      if (signer !== null && e) {
        try {
          const cs = await chain.checkSigner(signer, e.originHash, at);
          signerCode = { code: cs.code, agentId: cs.signer.agentId, releaseId: cs.signer.releaseId };
        } catch (err) {
          if (!(err instanceof RpcError)) throw err;
          if (at !== undefined) {
            try {
              signerCode = await chain.checkSignerFromEvents(signer, e.originHash, at, atTs);
            } catch (err2) {
              if (!(err2 instanceof RpcError)) throw err2;
              signerRpc = true;
            }
          } else signerRpc = true;
        }
      }
      // Rebuilt-from-events status also answers the release line when the direct read couldn't: OK means Approved.
      if (relState === undefined) {
        const same = signerCode?.agentId === proof.agentId && signerCode?.releaseId === proof.releaseId;
        if (same && signerCode?.code === 'OK') relState = RELEASE_STATUS.Approved;
        else if (same && signerCode?.code === 'RELEASE_NOT_APPROVED') relState = RELEASE_STATUS.Revoked;
        else releaseRpc = true;
      }

      if (relState === undefined) set('release', 'not_checked', releaseRpc ? RPC_OLD : 'release status unknown', relLink);
      else if (relState === RELEASE_STATUS.Approved) set('release', 'pass', `${rel} was Approved ${when}`, relLink);
      else set('release', 'fail', `${rel} was not Approved ${when} (${['unknown', 'Approved', 'Deprecated', 'Revoked'][relState] ?? 'unknown'})`, relLink);

      const sLink = addr(signer ?? chain.registry);
      if (!e) set('signer', 'not_checked', "the signer's service address is only in the local record of the call", sLink);
      else if (signer === null) set('signer', 'not_checked', 'no signer could be recovered from the proof', sLink);
      else if (signerRpc || !signerCode) set('signer', 'not_checked', RPC_OLD, sLink);
      else if (signerCode.code !== 'OK' && signerCode.code !== 'RELEASE_NOT_APPROVED')
        set('signer', 'fail', `signer ${short(signer)} was not Active for this service ${when} (${safe(signerCode.code)})`, sLink);
      else if (signerCode.agentId !== proof.agentId) set('signer', 'fail', `signer ${short(signer)} is registered to agent ${signerCode.agentId}, not agent ${proof.agentId}`, sLink);
      else if (signerCode.releaseId !== proof.releaseId) set('signer', 'fail', `signer ${short(signer)} was attested for another release, not ${short(proof.releaseId)}`, sLink);
      else set('signer', 'pass', `signer ${short(signer)} was Active and attested for ${short(proof.releaseId)} ${when}`, sLink);
    }

    const order: CheckId[] = ['release', 'signer', 'signature', 'binding', 'timing_and_inputs', 'settlement'];
    if (!base) d.io.out('No public explorer for --network local: links are left out.'); // not in FLOWS
    const list = order.map((c) => rows[c] ?? { check: c, status: 'not_checked' as const, detail: 'not run', link: null });
    const tag: Record<CheckStatus, string> = { pass: 'pass', fail: 'FAIL', not_checked: 'not checked' };
    for (const r of list) d.io.out(`${tag[r.status].padEnd(11)} ${r.check}: ${r.detail}${r.link ? `  ${r.link}` : ''}`);
    const failed = list.filter((r) => r.status === 'fail').length;
    const skipped = list.filter((r) => r.status === 'not_checked').length;
    const outcome = failed > 0 ? 'failed' : skipped > 0 ? 'incomplete' : 'verified';
    if (outcome === 'verified') d.io.out('Verified: every check passed.');
    else if (outcome === 'failed') {
      d.io.out(`Not verified: ${failed} check${failed === 1 ? '' : 's'} failed. Don't rely on this answer.`);
      d.io.out('Show this output to the service owner, or run `attessa status --agent <id>` to see its releases and signers.');
    } else {
      d.io.out(`Not fully verified: ${skipped} check${skipped === 1 ? ' was' : 's were'} not run.`);
      d.io.out('Give the proof and the answer you kept with --proof <file> --response <file>, or retry with another `--rpc`.');
    }
    d.io.data?.({ outcome, network: g.network, target, requestId: entry?.requestId ?? null, settlementTx: settlement?.tx ?? known ?? null, checks: list });
    return outcome === 'verified' ? 0 : 1;
  }

  /** V11 and the not-charged end (SPEC §7): the receipt holds both logs, or the authorization is unspent past validBefore. */
  async function settle(
    p: Payment,
    tx: Hex | null,
    e: PendingEntry | undefined,
  ): Promise<{ status: CheckStatus; detail: string; link: string | null; settlement: Settlement | null }> {
    if (tx) {
      const s = await chain.settlementIn(tx, p.asset, p.payer, p.payTo, p.amount, p.nonce);
      if (s) return { status: 'pass', detail: `settled in tx ${short(tx)} (block ${s.blockNumber}): the token's AuthorizationUsed and its Transfer to the service`, link: txLink(tx), settlement: s };
      return { status: 'fail', detail: `tx ${short(tx)} is not a settlement of this payment (no matching AuthorizationUsed and Transfer from the token)`, link: txLink(tx), settlement: null };
    }
    const validBefore = e?.validBefore ? BigInt(e.validBefore) : null;
    const tokenLink = addr(p.asset);
    if (validBefore === null) return { status: 'fail', detail: 'the payment window is not recorded, so unspent cannot be proven', link: tokenLink, settlement: null };
    const head = await chain.latest();
    if (head.timestamp <= validBefore + 5n)
      return { status: 'fail', detail: `not settled, and the payment permission can still be used until validBefore (${validBefore}); Celo is at ${head.timestamp}`, link: tokenLink, settlement: null };
    const used = await chain.authorizationState(p.asset, p.payer, p.nonce, head.number);
    if (!used) return { status: 'pass', detail: `not charged: the payment permission was never used and expired at ${validBefore} (checked at block ${head.number})`, link: tokenLink, settlement: null };
    const from = e?.signedAtBlock ? BigInt(e.signedAtBlock) : head.number > 2_000_000n ? head.number - 2_000_000n : 0n;
    const logs = await chain.authorizationLogs(p.asset, p.payer, p.nonce, from, head.number);
    for (const t of logs.used) {
      const s = await chain.settlementIn(t, p.asset, p.payer, p.payTo, p.amount, p.nonce);
      if (s) return { status: 'pass', detail: `settled in tx ${short(t)} (block ${s.blockNumber}): the token's AuthorizationUsed and its Transfer to the service`, link: txLink(t), settlement: s };
    }
    if (logs.canceled.length > 0) return { status: 'pass', detail: `not charged: the payment permission was cancelled in tx ${short(logs.canceled[0]!)}`, link: txLink(logs.canceled[0]!), settlement: null };
    return { status: 'fail', detail: 'the payment permission reads used or cancelled, but no matching settlement or cancel was found', link: tokenLink, settlement: null };
  }
}

/** Tx form without a local record: the pinned asset's AuthorizationUsed and the Transfer from that payer, in one successful tx. */
async function paymentInTx(chain: Chain, deployment: Deployment, tx: Hex): Promise<Payment | null> {
  let receipt;
  try {
    receipt = await chain.client.getTransactionReceipt({ hash: tx });
  } catch (e) {
    if ((e as Error).name === 'TransactionReceiptNotFoundError') return null;
    throw new RpcError(`receipt ${tx}`, { cause: e });
  }
  if (receipt.status !== 'success') return null;
  for (const a of Object.values(deployment.assets)) {
    const logs = receipt.logs.filter((l) => lc(l.address) === lc(a.address));
    const events = parseEventLogs({ abi: tokenLogs, logs, strict: true });
    for (const u of events) {
      if (u.eventName !== 'AuthorizationUsed') continue;
      const t = events.find((x) => x.eventName === 'Transfer' && lc(x.args.from) === lc(u.args.authorizer));
      if (t && t.eventName === 'Transfer')
        return { asset: lc(a.address) as Address, payer: lc(u.args.authorizer) as Address, payTo: lc(t.args.to) as Address, amount: t.args.value, nonce: lc(u.args.nonce) as Hex };
    }
  }
  return null;
}
