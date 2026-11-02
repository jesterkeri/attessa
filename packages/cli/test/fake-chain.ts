import { encodeUserData, originHash as hashOrigin, releaseId as computeReleaseId, signerFromPublicKey } from '@attessa/core';
import {
  decodeFunctionData,
  parseAbiItem,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  size,
  toEventSelector,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type TransactionSerialized,
} from 'viem';
import { CERT_MANAGER_ABI, IDENTITY_ABI, REGISTRY_ABI, VALIDATOR_ABI } from '../src/abi.ts';
import { hintPlan, parseAttestation } from '../src/attestation.ts';
import { RpcError, RpcUnavailable, type Rpc } from '../src/rpc.ts';

/**
 * In-process JSON-RPC chain with a JS model of EnclaveRegistry (SPEC §3.4, the checks the CLI's
 * commands hit), the identity registry, NitroValidator and CertManager's cache. No network: every
 * request, including `eth_sendRawTransaction`, stays in this object, and `sent` records them.
 */

export const REGISTRY = '0x00000000000000000000000000000000000000e1' as Address;
export const IDENTITY = '0x8004a818bfb912233c491871b3d84c89a494bd9e' as Address;
export const VALIDATOR = '0x00000000000000000000000000000000000000e2' as Address;
export const CERT_MANAGER = '0x00000000000000000000000000000000000000e3' as Address;
const ENDPOINT_ADDED = parseAbiItem('event EndpointAdded(bytes32 indexed originHash, uint256 indexed agentId, string origin, address payTo, address operator)');

class Revert extends Error {
  readonly data: Hex;
  constructor(data: Hex) {
    super('execution reverted');
    this.data = data;
  }
}
const custom = (errorName: string, args: unknown[] = []) =>
  new Revert(encodeErrorResult({ abi: REGISTRY_ABI, errorName, args } as never));
const reason = (msg: string) => new Revert(encodeErrorResult({ abi: CERT_MANAGER_ABI, errorName: 'Error', args: [msg] }));

export class FakeChain implements Rpc {
  readonly url = 'fake://chain';
  chainId = 11142220;
  blockNumber = 5_000_000n;
  timestamp = 1_793_000_000n;
  gasPrice = 25_000_000_000n;
  owners = new Map<bigint, Address>();
  releases = new Map<string, number>();
  endpoints = new Map<Hex, { agentId: bigint; payTo: Address; operator: Address; status: number }>();
  signers = new Map<Address, { agentId: bigint; releaseId: Hex; originHash: Hex; operator: Address; registeredAt: bigint; expiresAt: bigint; status: number; attestationHash: Hex }>();
  certs = new Map<Hex, { notAfter: bigint; parent: Hex }>();
  rootHash: Hex = '0x311d96fcd5c5e0ccf72ef548e2ea7d4c0cd53ad7c4cc49e67471aed41d61f185';
  logs: Array<{ address: Address; topics: Hex[]; data: Hex }> = [];
  readonly sent: Hex[] = [];
  readonly calls: Array<{ method: string; params: unknown[] }> = [];
  private receipts = new Map<Hex, { status: string; blockNumber: string; gasUsed: string }>();
  nonces = new Map<string, number>();
  down = false;
  /** Gas each write costs in eth_estimateGas. */
  gasFor = (fn: string) => (fn === 'approveRelease' || fn === 'addEndpoint' ? 200_000n : 10_000_000n);

  async request(method: string, params: unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.down) throw new RpcUnavailable('connect ECONNREFUSED');
    try {
      return this.handle(method, params);
    } catch (e) {
      if (e instanceof Revert) throw new RpcError(3, 'execution reverted', e.data);
      throw e;
    }
  }

  private handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'eth_chainId':
        return toHex(this.chainId);
      case 'eth_getBlockByNumber':
        return { number: toHex(this.blockNumber), timestamp: toHex(this.timestamp) };
      case 'eth_gasPrice':
        return toHex(this.gasPrice);
      case 'eth_maxPriorityFeePerGas':
        return toHex(1_000_000_000n);
      case 'eth_getTransactionCount':
        return toHex(this.nonces.get(String(params[0]).toLowerCase()) ?? 0);
      case 'eth_call': {
        const tx = params[0] as { from?: Address; to: Address; data: Hex };
        return this.exec(tx.from?.toLowerCase() as Address | undefined, tx.to.toLowerCase() as Address, tx.data, false).out;
      }
      case 'eth_estimateGas': {
        const tx = params[0] as { from: Address; to: Address; data: Hex };
        return toHex(this.exec(tx.from.toLowerCase() as Address, tx.to.toLowerCase() as Address, tx.data, false).gas);
      }
      case 'eth_sendRawTransaction':
        return this.applyRaw(params[0] as Hex);
      case 'eth_getTransactionReceipt':
        return this.receipts.get(params[0] as Hex) ?? null;
      case 'eth_getLogs': {
        const f = params[0] as { address: Address; topics: Hex[] };
        return this.logs.filter((l) => l.address === f.address.toLowerCase() && f.topics.every((t, i) => !t || l.topics[i] === t));
      }
      default:
        throw new Error(`fake chain: ${method} unsupported`);
    }
  }

  private applyRaw(raw: Hex): Hex {
    this.sent.push(raw);
    const tx = parseTransaction(raw as TransactionSerialized);
    if (tx.chainId !== this.chainId) throw new Error('fake chain: wrong chain id');
    const hash = keccak256(raw);
    // Sender recovery is async in viem; the receipt is written once it resolves (before the CLI polls).
    this.pending = recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized }).then((from) => {
      const f = from.toLowerCase();
      this.nonces.set(f, (this.nonces.get(f) ?? 0) + 1);
      this.blockNumber++;
      this.timestamp += 2n;
      try {
        this.exec(f as Address, tx.to!.toLowerCase() as Address, tx.data!, true);
        this.receipts.set(hash, { status: '0x1', blockNumber: toHex(this.blockNumber), gasUsed: toHex(100_000n) });
      } catch {
        this.receipts.set(hash, { status: '0x0', blockNumber: toHex(this.blockNumber), gasUsed: toHex(100_000n) });
      }
    });
    return hash;
  }
  pending: Promise<void> = Promise.resolve();

  private result(abi: Abi, functionName: string, value: unknown): Hex {
    return encodeFunctionResult({ abi, functionName, result: value } as never);
  }

  exec(from: Address | undefined, to: Address, data: Hex, write: boolean): { out: Hex; gas: bigint } {
    if (to === IDENTITY) {
      const { args } = decodeFunctionData({ abi: IDENTITY_ABI, data });
      const o = this.owners.get(args[0] as bigint);
      if (!o) throw reason('ERC721NonexistentToken');
      return { out: this.result(IDENTITY_ABI, 'ownerOf', o), gas: 30_000n };
    }
    if (to === VALIDATOR) return { out: this.result(VALIDATOR_ABI, 'certManager', CERT_MANAGER), gas: 30_000n };
    if (to === CERT_MANAGER) return this.certManager(data, write);
    if (to !== REGISTRY) throw new Error(`fake chain: call to ${to}`);
    const { functionName, args } = decodeFunctionData({ abi: REGISTRY_ABI, data });
    const a = args as readonly any[];
    const gas = this.gasFor(functionName);
    const ret = (v: unknown) => ({ out: this.result(REGISTRY_ABI, functionName, v), gas });
    switch (functionName) {
      case 'identityRegistry':
        return ret(IDENTITY);
      case 'nitroValidator':
        return ret(VALIDATOR);
      case 'allowLocalOrigins':
        return ret(false);
      case 'releases':
        return ret({ status: this.releases.get(`${a[0]}:${a[1]}`) ?? 0, approvedAt: 0n, statusChangedAt: 0n });
      case 'endpoints': {
        const e = this.endpoints.get((a[0] as Hex).toLowerCase() as Hex);
        return ret(e ? { ...e, updatedAt: 0n } : { agentId: 0n, payTo: '0x0000000000000000000000000000000000000000', operator: '0x0000000000000000000000000000000000000000', status: 0, updatedAt: 0n });
      }
      case 'signers': {
        const s = this.signers.get((a[0] as string).toLowerCase() as Address);
        const zero = `0x${'00'.repeat(32)}` as Hex;
        return ret(s ?? { agentId: 0n, releaseId: zero, originHash: zero, operator: '0x0000000000000000000000000000000000000000', registeredAt: 0n, expiresAt: 0n, status: 0, attestationHash: zero });
      }
      case 'approveRelease': {
        const [agentId, p0, p1, p2] = a as [bigint, Hex, Hex, Hex];
        if (this.owners.get(agentId) !== from) throw custom('NotOwner');
        const rid = computeReleaseId(p0, p1, p2);
        if (this.releases.has(`${agentId}:${rid}`)) throw custom('ReleaseExists');
        if (write) this.releases.set(`${agentId}:${rid}`, 1);
        return ret(rid);
      }
      case 'addEndpoint': {
        const [agentId, origin, payTo, operator] = a as [bigint, string, Address, Address];
        if (this.owners.get(agentId) !== from) throw custom('NotOwner');
        const oh = hashOrigin(origin);
        if (this.endpoints.get(oh)?.status === 1) throw custom('OriginTaken');
        if (write) this.addEndpoint(agentId, origin, payTo, operator);
        return ret(oh);
      }
      case 'registerSigner':
      case 'renewSigner':
        return this.signer(functionName, from!, a, write, gas);
      default:
        throw new Error(`fake chain: registry.${functionName}`);
    }
  }

  /** State and `EndpointAdded` log of a successful addEndpoint. */
  addEndpoint(agentId: bigint, origin: string, payTo: Address, operator: Address): void {
    const oh = hashOrigin(origin);
    this.endpoints.set(oh, { agentId, payTo: payTo.toLowerCase() as Address, operator: operator.toLowerCase() as Address, status: 1 });
    this.logs.push({
      address: REGISTRY,
      topics: [toEventSelector(ENDPOINT_ADDED), oh, toHex(agentId, { size: 32 })],
      data: encodeAbiParameters([{ type: 'string' }, { type: 'address' }, { type: 'address' }], [origin, payTo, operator]),
    });
  }

  private certManager(data: Hex, write: boolean): { out: Hex; gas: bigint } {
    const { functionName, args } = decodeFunctionData({ abi: CERT_MANAGER_ABI, data });
    const a = args as readonly any[];
    if (functionName === 'loadVerified') {
      const c = this.certs.get(a[0] as Hex);
      return {
        out: this.result(CERT_MANAGER_ABI, 'loadVerified', { ca: true, notAfter: c?.notAfter ?? 0n, maxPathLen: 0n, subjectHash: `0x${'00'.repeat(32)}`, pubKey: c ? `0x${'11'.repeat(96)}` : '0x' }),
        gas: 30_000n,
      };
    }
    const [cert, parent] = a as [Hex, Hex];
    if (parent !== this.rootHash && !this.certs.has(parent)) throw reason('parent cert unverified');
    // The CLI's own parser stands in for CertManager's ASN.1 walk here.
    const tbsHash = keccak256(tbsOf(cert));
    if (write) this.certs.set(tbsHash, { notAfter: this.timestamp + 3600n, parent });
    return {
      out: functionName === 'verifyCACertWithHints'
        ? this.result(CERT_MANAGER_ABI, functionName, tbsHash)
        : this.result(CERT_MANAGER_ABI, functionName, { ca: false, notAfter: this.timestamp + 3600n, maxPathLen: 0n, subjectHash: tbsHash, pubKey: `0x${'11'.repeat(96)}` }),
      gas: 9_000_000n,
    };
  }

  private signer(fn: 'registerSigner' | 'renewSigner', from: Address, a: readonly any[], write: boolean, gas: bigint): { out: Hex; gas: bigint } {
    const doc = Buffer.from((fn === 'registerSigner' ? a[2] : a[1]).slice(2), 'hex');
    const att = parseAttestation(doc);
    let agentId: bigint;
    let oh: Hex;
    let existing = null as ReturnType<typeof this.signers.get> | null;
    if (fn === 'registerSigner') {
      agentId = a[0];
      oh = (a[1] as Hex).toLowerCase() as Hex;
      const e = this.endpoints.get(oh);
      if (e?.status !== 1) throw custom('EndpointInactive');
      if (e.agentId !== agentId) throw custom('EndpointMismatch');
      if (from !== e.operator) throw custom('NotOperator');
    } else {
      existing = this.signers.get((a[0] as string).toLowerCase() as Address) ?? null;
      if (!existing || existing.status !== 1 || this.timestamp >= existing.expiresAt) throw custom('SignerNotActive');
      agentId = existing.agentId;
      oh = existing.originHash;
      const e = this.endpoints.get(oh)!;
      if (from !== e.operator || e.operator !== existing.operator) throw custom('NotOperator');
    }
    // NitroValidator: the whole chain must be cached (it re-walks it with empty hints).
    for (const c of hintPlan(att).certs) if (!this.certs.has(c.certHash)) throw reason('inverse hint underflow');
    const ts = att.timestampMs / 1000n;
    if (ts > this.timestamp + 60n) throw custom('AttestationFromFuture');
    if (this.timestamp - ts > 1800n) throw custom('AttestationStale');
    const pcrs = [0, 1, 2].map((i) => att.pcrs.get(i)!);
    if (pcrs.some((p) => /^0x0+$/.test(p))) throw custom('DebugPcrs');
    const rid = computeReleaseId(pcrs[0]!, pcrs[1]!, pcrs[2]!);
    if (this.releases.get(`${agentId}:${rid}`) !== 1) throw custom('ReleaseNotApproved');
    const want = encodeUserData({ chainId: BigInt(this.chainId), registry: REGISTRY, agentId, originHash: oh });
    if (!att.userData || size(att.userData) !== 160) throw custom('BindingMismatch', [0]);
    if (att.userData.toLowerCase() !== want.toLowerCase()) throw custom('BindingMismatch', [5]);
    const signer = signerFromPublicKey(att.publicKey!);
    if (fn === 'registerSigner') {
      if (this.signers.has(signer)) throw custom('SignerExists');
      if (write) {
        this.signers.set(signer, { agentId, releaseId: rid, originHash: oh, operator: from, registeredAt: this.timestamp, expiresAt: this.timestamp + 604800n, status: 1, attestationHash: keccak256(doc) });
      }
      return { out: this.result(REGISTRY_ABI, fn, signer), gas };
    }
    if (signer !== (a[0] as string).toLowerCase()) throw custom('SignerMismatch');
    if (rid !== existing!.releaseId) throw custom('ReleaseMismatch');
    if (write) existing!.expiresAt = this.timestamp + 604800n;
    return { out: '0x', gas };
  }
}

/** keccak input for a cert's CertManager cache key: its tbsCertificate (outer SEQUENCE's first element). */
function tbsOf(certHex: Hex): Hex {
  const b = Buffer.from(certHex.slice(2), 'hex');
  const read = (at: number) => {
    let len = b[at + 1]!;
    let hdr = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + b[at + 2 + i]!;
      hdr += n;
    }
    return { start: at, contentStart: at + hdr, end: at + hdr + len };
  };
  const outer = read(0);
  const tbs = read(outer.contentStart);
  return toHex(b.subarray(tbs.start, tbs.end));
}

