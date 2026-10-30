import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  stringToBytes,
  toHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hash,
  type Hex,
  type Transport,
} from 'viem';
import { EIP3009_TYPES, identityAbi, registryAbi, selfAbi, tokenAbi } from '../../src/abi.ts';

// An in-memory Celo at the JSON-RPC level, so the SDK's real viem calls run against it. Registry and
// token state are versioned per block, so eth_call at a past block answers as the chain did then.
// Nothing here talks to a network.

const lc = <T extends string>(s: T) => s.toLowerCase() as T;
const ZERO: Address = '0x0000000000000000000000000000000000000000';

export interface EndpointS { agentId: bigint; payTo: Address; operator: Address; status: number; updatedAt: bigint }
export interface SignerS { agentId: bigint; releaseId: Hex; originHash: Hex; operator: Address; registeredAt: bigint; expiresAt: bigint; status: number; attestationHash: Hex }
export interface AccountS { code: Hex; nonce: bigint; balance: bigint }

interface State {
  endpoints: Record<string, EndpointS>;
  signers: Record<string, SignerS>;
  releases: Record<string, number>;
  accounts: Record<string, AccountS>;
  /** `${asset}:${payer}:${nonce}` → used/canceled */
  auth: Record<string, 'used' | 'canceled'>;
  selfLinks: Record<string, bigint>;
}

interface Block { number: bigint; hash: Hex; timestamp: bigint }
interface RpcLog { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint; transactionHash: Hash; logIndex: number }
interface Receipt { hash: Hash; blockNumber: bigint; status: 'success' | 'reverted'; logs: RpcLog[]; from: Address; to: Address }

export class RpcFailure extends Error {
  code: number;
  constructor(message: string, code = -32000) {
    super(message);
    this.code = code;
  }
}

export class FakeChain {
  readonly chainId: number;
  readonly registry: Address;
  readonly asset: Address;
  readonly identity: Address = '0x8004a818bfb912233c491871b3d84c89a494bd9e';
  readonly self: Address = '0x043dacac8b0771dd5b444bcc88f2f8bbdbedd379';
  readonly tokenName: string;
  readonly tokenVersion: string;
  blocks: Block[] = [];
  private snapshots: { block: bigint; state: State }[] = [];
  private state: State;
  logs: RpcLog[] = [];
  receipts = new Map<string, Receipt>();
  /** eth_call / account reads older than this many blocks fail with "missing trie node". */
  stateDepth = Number.POSITIVE_INFINITY;
  /** The RPC reports `latest` this many blocks behind the real head. */
  headLag = 0;
  /** Methods that fail outright. */
  failing = new Set<string>();
  /** eth_getLogs fails while true. */
  logsDown = false;
  calls: string[] = [];
  agentOwners: Record<string, Address> = {};

  constructor(opts: { chainId?: number; registry?: Address; asset?: Address; tokenName?: string; tokenVersion?: string; startTime?: bigint; startBlock?: bigint } = {}) {
    this.chainId = opts.chainId ?? 11142220;
    this.registry = lc(opts.registry ?? '0x5fbdb2315678afecb367f032d93f642f64180aa3');
    this.asset = lc(opts.asset ?? '0x01c5c0122039549ad1493b8220cabedd739bc44e');
    this.tokenName = opts.tokenName ?? 'USDC';
    this.tokenVersion = opts.tokenVersion ?? '2';
    this.state = { endpoints: {}, signers: {}, releases: {}, accounts: {}, auth: {}, selfLinks: {} };
    const n = opts.startBlock ?? 1000n;
    const t = opts.startTime ?? BigInt(Math.floor(Date.now() / 1000));
    this.blocks.push({ number: n, hash: this.blockHash(n), timestamp: t });
    this.snapshots.push({ block: n, state: structuredClone(this.state) });
  }

  private blockHash(n: bigint): Hex {
    return keccak256(stringToBytes(`fake-block-${this.chainId}-${n}`));
  }

  get head(): Block {
    return this.blocks.at(-1)!;
  }

  /** The block the RPC calls `latest`. */
  get reportedHead(): Block {
    return this.blocks[Math.max(0, this.blocks.length - 1 - this.headLag)]!;
  }

  /** Mines one block `dt` seconds after the head and snapshots the state. */
  mine(dt = 1n): Block {
    const n = this.head.number + 1n;
    const b = { number: n, hash: this.blockHash(n), timestamp: this.head.timestamp + dt };
    this.blocks.push(b);
    this.snapshots.push({ block: n, state: structuredClone(this.state) });
    return b;
  }

  /** Advances chain time by `seconds`, one block per second. */
  advance(seconds: number): void {
    for (let i = 0; i < Math.max(1, Math.round(seconds)); i++) this.mine();
  }

  blockAt(n: bigint): Block | undefined {
    const i = Number(n - this.blocks[0]!.number);
    return this.blocks[i];
  }

  stateAt(n: bigint): State {
    let s = this.snapshots[0]!.state;
    for (const snap of this.snapshots) if (snap.block <= n) s = snap.state;
    return s;
  }

  // ---- mutations: each runs in a new block, as one transaction

  private tx(from: Address, to: Address, f: (emit: (abi: Abi, address: Address, eventName: string, args: Record<string, unknown>) => void) => boolean): Hash {
    const n = this.head.number + 1n;
    const hash = keccak256(stringToBytes(`fake-tx-${n}-${this.receipts.size}-${Math.random()}`));
    const logs: RpcLog[] = [];
    const emit = (abi: Abi, address: Address, eventName: string, args: Record<string, unknown>) => {
      const ev = abi.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
      const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
      const nonIndexed = ev.inputs.filter((i) => !i.indexed);
      const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never);
      logs.push({ address: lc(address), topics, data, blockNumber: n, transactionHash: hash, logIndex: this.logs.length + logs.length });
    };
    const ok = f(emit);
    this.mine();
    if (ok) this.logs.push(...logs);
    this.receipts.set(hash, { hash, blockNumber: n, status: ok ? 'success' : 'reverted', logs: ok ? logs : [], from: lc(from), to: lc(to) });
    return hash;
  }

  setAccount(address: Address, a: AccountS): void {
    this.state.accounts[lc(address)] = a;
    this.mine();
  }

  approveRelease(agentId: bigint, releaseId: Hex, sourceRef = 'github.com/acme/risk@a1b2c3d'): Hash {
    return this.tx(ZERO, this.registry, (emit) => {
      this.state.releases[`${agentId}:${lc(releaseId)}`] = 1;
      const pcr = toHex(new Uint8Array(48).fill(1));
      emit(registryAbi, this.registry, 'ReleaseApproved', { agentId, releaseId, pcr0: pcr, pcr1: pcr, pcr2: pcr, sourceRef });
      return true;
    });
  }

  setReleaseStatus(agentId: bigint, releaseId: Hex, to: number): Hash {
    return this.tx(ZERO, this.registry, (emit) => {
      const k = `${agentId}:${lc(releaseId)}`;
      const from = this.state.releases[k] ?? 0;
      this.state.releases[k] = to;
      emit(registryAbi, this.registry, 'ReleaseStatusChanged', { agentId, releaseId, from, to });
      return true;
    });
  }

  addEndpoint(agentId: bigint, origin: string, originHash: Hex, payTo: Address, operator: Address): Hash {
    return this.tx(ZERO, this.registry, (emit) => {
      this.state.endpoints[lc(originHash)] = { agentId, payTo: lc(payTo), operator: lc(operator), status: 1, updatedAt: this.head.timestamp };
      emit(registryAbi, this.registry, 'EndpointAdded', { originHash, agentId, origin, payTo, operator });
      return true;
    });
  }

  retireEndpoint(originHash: Hex): Hash {
    return this.tx(ZERO, this.registry, (emit) => {
      const e = this.state.endpoints[lc(originHash)]!;
      e.status = 2;
      emit(registryAbi, this.registry, 'EndpointRetired', { originHash, agentId: e.agentId });
      return true;
    });
  }

  registerSigner(signer: Address, agentId: bigint, releaseId: Hex, originHash: Hex, operator: Address): Hash {
    return this.tx(operator, this.registry, (emit) => {
      const now = this.head.timestamp + 1n;
      const s: SignerS = {
        agentId,
        releaseId: lc(releaseId),
        originHash: lc(originHash),
        operator: lc(operator),
        registeredAt: now,
        expiresAt: now + 604800n,
        status: 1,
        attestationHash: keccak256(stringToBytes(`att-${signer}`)),
      };
      this.state.signers[lc(signer)] = s;
      emit(registryAbi, this.registry, 'SignerRegistered', {
        signer, agentId, releaseId, originHash, operator, expiresAt: s.expiresAt, attestationHash: s.attestationHash, attestationTimestamp: now,
      });
      return true;
    });
  }

  revokeSigner(signer: Address): Hash {
    return this.tx(ZERO, this.registry, (emit) => {
      const s = this.state.signers[lc(signer)]!;
      s.status = 2;
      emit(registryAbi, this.registry, 'SignerRevoked', { signer, agentId: s.agentId });
      return true;
    });
  }

  /**
   * The facilitator's transferWithAuthorization. `transferTo`/`value` let a test make a tx whose
   * Transfer doesn't match (used elsewhere).
   */
  settle(payer: Address, payTo: Address, value: bigint, nonce: Hex, opts: { transferTo?: Address; value?: bigint } = {}): Hash {
    return this.tx('0x00000000000000000000000000000000000fac11', this.asset, (emit) => {
      const k = `${this.asset}:${lc(payer)}:${lc(nonce)}`;
      if (this.state.auth[k]) return false; // a used or canceled nonce reverts
      this.state.auth[k] = 'used';
      emit(tokenAbi, this.asset, 'AuthorizationUsed', { authorizer: payer, nonce });
      emit(tokenAbi, this.asset, 'Transfer', { from: payer, to: opts.transferTo ?? payTo, value: opts.value ?? value });
      return true;
    });
  }

  authUsed(payer: Address, nonce: Hex): boolean {
    return this.state.auth[`${this.asset}:${lc(payer)}:${lc(nonce)}`] !== undefined;
  }

  // ---- JSON-RPC

  transport(): Transport {
    return custom({ request: ({ method, params }) => this.request(method, params as unknown[]) }, { retryCount: 0 });
  }

  private resolveTag(tag: unknown): bigint {
    if (tag === undefined || tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized') return this.reportedHead.number;
    if (tag === 'earliest') return this.blocks[0]!.number;
    return BigInt(tag as string);
  }

  private historical(n: bigint): void {
    if (n > this.reportedHead.number) throw new RpcFailure('header not found');
    if (Number(this.head.number - n) > this.stateDepth) throw new RpcFailure('missing trie node');
  }

  private formatBlock(b: Block) {
    return {
      number: numberToHex(b.number),
      hash: b.hash,
      parentHash: this.blockHash(b.number - 1n),
      timestamp: numberToHex(b.timestamp),
      baseFeePerGas: '0x5d21dba00',
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
      miner: ZERO,
      extraData: '0x',
      logsBloom: `0x${'0'.repeat(512)}`,
      transactions: [],
      size: '0x0',
      nonce: '0x0000000000000000',
      difficulty: '0x0',
      sha3Uncles: '0x' + '0'.repeat(64),
      stateRoot: '0x' + '0'.repeat(64),
      receiptsRoot: '0x' + '0'.repeat(64),
      transactionsRoot: '0x' + '0'.repeat(64),
      uncles: [],
    };
  }

  private formatLog(l: RpcLog) {
    return {
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: numberToHex(l.blockNumber),
      blockHash: this.blockHash(l.blockNumber),
      transactionHash: l.transactionHash,
      transactionIndex: '0x0',
      logIndex: numberToHex(l.logIndex),
      removed: false,
    };
  }

  async request(method: string, params: unknown[] = []): Promise<unknown> {
    this.calls.push(method);
    if (this.failing.has(method)) throw new RpcFailure(`${method} unavailable`);
    switch (method) {
      case 'eth_chainId':
        return numberToHex(this.chainId);
      case 'eth_blockNumber':
        return numberToHex(this.reportedHead.number);
      case 'eth_getBlockByNumber': {
        const n = this.resolveTag(params[0]);
        const b = n <= this.reportedHead.number ? this.blockAt(n) : undefined;
        return b ? this.formatBlock(b) : null;
      }
      case 'eth_getTransactionReceipt': {
        const r = this.receipts.get(params[0] as string);
        if (!r || r.blockNumber > this.reportedHead.number) return null;
        return {
          transactionHash: r.hash,
          blockNumber: numberToHex(r.blockNumber),
          blockHash: this.blockHash(r.blockNumber),
          transactionIndex: '0x0',
          from: r.from,
          to: r.to,
          status: r.status === 'success' ? '0x1' : '0x0',
          logs: r.logs.map((l) => this.formatLog(l)),
          logsBloom: `0x${'0'.repeat(512)}`,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x5d21dba00',
          contractAddress: null,
          type: '0x2',
        };
      }
      case 'eth_getLogs': {
        if (this.logsDown) throw new RpcFailure('eth_getLogs unavailable');
        const f = params[0] as { address?: string | string[]; topics?: (string | string[] | null)[]; fromBlock?: string; toBlock?: string };
        const from = this.resolveTag(f.fromBlock ?? 'latest');
        const to = this.resolveTag(f.toBlock ?? 'latest');
        const addrs = f.address === undefined ? undefined : (Array.isArray(f.address) ? f.address : [f.address]).map(lc);
        return this.logs
          .filter((l) => l.blockNumber >= from && l.blockNumber <= to && l.blockNumber <= this.reportedHead.number)
          .filter((l) => !addrs || addrs.includes(l.address))
          .filter((l) =>
            (f.topics ?? []).every((t, i) => t === null || t === undefined || (Array.isArray(t) ? t.map(lc) : [lc(t)]).includes(lc(l.topics[i] ?? '0x'))),
          )
          .map((l) => this.formatLog(l));
      }
      case 'eth_getCode':
      case 'eth_getTransactionCount':
      case 'eth_getBalance': {
        const n = this.resolveTag(params[1]);
        if (method === 'eth_getTransactionCount' && params[1] === 'pending') return '0x0';
        this.historical(n);
        const a = this.stateAt(n).accounts[lc(params[0] as string)] ?? { code: '0x', nonce: 0n, balance: 0n };
        return method === 'eth_getCode' ? a.code : numberToHex(method === 'eth_getBalance' ? a.balance : a.nonce);
      }
      case 'eth_call': {
        const call = params[0] as { to: Address; data: Hex };
        const n = this.resolveTag(params[1]);
        this.historical(n);
        return this.call(lc(call.to), call.data, n);
      }
      case 'eth_estimateGas':
        return '0x186a0';
      case 'eth_gasPrice':
      case 'eth_maxPriorityFeePerGas':
        return '0x3b9aca00';
      case 'eth_sendRawTransaction':
        return this.sendRaw(params[0] as Hex);
      default:
        throw new RpcFailure(`method ${method} not supported by the fake`, -32601);
    }
  }

  private call(to: Address, data: Hex, n: bigint): Hex {
    const st = this.stateAt(n);
    const ts = this.blockAt(n)!.timestamp;
    if (to === this.registry) {
      const { functionName, args } = decodeFunctionData({ abi: registryAbi, data });
      const enc = (result: unknown) => encodeFunctionResult({ abi: registryAbi, functionName, result } as never);
      const emptyE: EndpointS = { agentId: 0n, payTo: ZERO, operator: ZERO, status: 0, updatedAt: 0n };
      const emptyS: SignerS = { agentId: 0n, releaseId: `0x${'0'.repeat(64)}`, originHash: `0x${'0'.repeat(64)}`, operator: ZERO, registeredAt: 0n, expiresAt: 0n, status: 0, attestationHash: `0x${'0'.repeat(64)}` };
      switch (functionName) {
        case 'endpoints':
          return enc(st.endpoints[lc(args[0] as Hex)] ?? emptyE);
        case 'signers':
          return enc(st.signers[lc(args[0] as Hex)] ?? emptyS);
        case 'selfLinks':
          return enc(st.selfLinks[String(args[0])] ?? 0n);
        case 'identityRegistry':
          return enc(this.identity);
        case 'selfRegistry':
          return enc(this.self);
        case 'checkSigner': {
          const s = st.signers[lc(args[0] as Hex)] ?? emptyS;
          const e = st.endpoints[lc(args[1] as Hex)] ?? emptyE;
          let code = 0;
          if (s.status === 0) code = 1;
          else if (s.status === 2) code = 2;
          else if (ts >= s.expiresAt) code = 3;
          else if (s.originHash !== lc(args[1] as Hex)) code = 6;
          else if (e.status !== 1) code = 5;
          else if (e.agentId !== s.agentId) code = 7;
          else if (e.operator !== s.operator) code = 8;
          else if (st.releases[`${s.agentId}:${s.releaseId}`] !== 1) code = 4;
          return enc([code, s, e]);
        }
        default:
          throw new RpcFailure(`registry.${functionName} not faked`);
      }
    }
    if (to === this.asset) {
      const { functionName, args } = decodeFunctionData({ abi: tokenAbi, data });
      if (functionName !== 'authorizationState') throw new RpcFailure(`token.${functionName} is not a view`);
      const k = `${this.asset}:${lc(args[0] as Hex)}:${lc(args[1] as Hex)}`;
      return encodeFunctionResult({ abi: tokenAbi, functionName, result: st.auth[k] !== undefined });
    }
    if (to === this.identity) {
      const { args } = decodeFunctionData({ abi: identityAbi, data });
      return encodeFunctionResult({ abi: identityAbi, functionName: 'ownerOf', result: this.agentOwners[String(args[0])] ?? ZERO });
    }
    if (to === this.self) {
      decodeFunctionData({ abi: selfAbi, data });
      throw new RpcFailure('execution reverted');
    }
    throw new RpcFailure(`no contract at ${to}`);
  }

  private async sendRaw(raw: Hex): Promise<Hash> {
    const tx = parseTransaction(raw);
    const from = lc(await recoverTransactionAddress({ serializedTransaction: raw as never }));
    if (lc(tx.to!) !== this.asset) throw new RpcFailure('only the token is faked for transactions');
    const { functionName, args } = decodeFunctionData({ abi: tokenAbi, data: tx.data! });
    if (functionName !== 'cancelAuthorization') throw new RpcFailure(`token.${functionName} not faked`);
    const [authorizer, nonce, v, r, s] = args as [Address, Hex, number, Hex, Hex];
    const signer = await recoverTypedDataAddress({
      domain: { name: this.tokenName, version: this.tokenVersion, chainId: this.chainId, verifyingContract: this.asset },
      types: { CancelAuthorization: EIP3009_TYPES.CancelAuthorization },
      primaryType: 'CancelAuthorization',
      message: { authorizer, nonce },
      signature: { r, s, v: BigInt(v) },
    });
    return this.tx(from, this.asset, (emit) => {
      const k = `${this.asset}:${lc(authorizer)}:${lc(nonce)}`;
      if (lc(signer) !== lc(authorizer) || this.state.auth[k]) return false;
      this.state.auth[k] = 'canceled';
      emit(tokenAbi, this.asset, 'AuthorizationCanceled', { authorizer, nonce });
      return true;
    });
  }
}
