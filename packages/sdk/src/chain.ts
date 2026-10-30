import {
  createPublicClient,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type PublicClient,
  type Transport,
} from 'viem';
import { CHECK, ENDPOINT_STATUS, RELEASE_STATUS, SIGNER_STATUS, identityAbi, registryAbi, selfAbi, tokenAbi, type CheckName } from './abi.ts';

/** Any failure to read the chain. Never a ProofCheck (SPEC §7 V10). */
export class RpcError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RpcError';
  }
}

export interface BlockHeader {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

export interface EndpointRec {
  agentId: bigint;
  payTo: Address;
  operator: Address;
  status: number;
}

export interface SignerRec {
  agentId: bigint;
  releaseId: Hex;
  originHash: Hex;
  operator: Address;
  expiresAt: bigint;
  status: number;
}

export interface SignerCheck {
  code: CheckName;
  signer: SignerRec;
  endpoint: EndpointRec;
}

export interface Settlement {
  tx: Hash;
  blockNumber: bigint;
  timestamp: bigint;
}

/** eth_getLogs chunk size (SPEC §7 V10: 1,000-block chunks). */
export const LOG_CHUNK = 1000n;
/** How far back the event rebuild of signer status scans before giving up (about 23 days of Celo blocks). */
export const MAX_REBUILD_BLOCKS = 2_000_000n;

const lc = (a: string) => a.toLowerCase();

async function rpc<T>(what: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new RpcError(`${what}: ${(e as Error).message?.split('\n')[0] ?? String(e)}`, { cause: e });
  }
}

/** The chain reads the SDK makes, over a viem public client. */
export class Chain {
  readonly client: PublicClient;
  readonly registry: Address;

  constructor(transport: Transport, registry: Address) {
    this.client = createPublicClient({ transport }) as PublicClient;
    this.registry = registry;
  }

  chainId(): Promise<number> {
    return rpc('eth_chainId', () => this.client.getChainId());
  }

  async latest(): Promise<BlockHeader> {
    const b = await rpc('latest block', () => this.client.getBlock({ blockTag: 'latest' }));
    return { number: b.number!, hash: b.hash!, timestamp: b.timestamp };
  }

  async block(n: bigint): Promise<BlockHeader> {
    const b = await rpc(`block ${n}`, () => this.client.getBlock({ blockNumber: n }));
    return { number: b.number!, hash: b.hash!, timestamp: b.timestamp };
  }

  async endpoint(originHash: Hex, blockNumber?: bigint): Promise<EndpointRec> {
    const e = await rpc('endpoints()', () =>
      this.client.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'endpoints',
        args: [originHash],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      }),
    );
    return { agentId: e.agentId, payTo: lc(e.payTo) as Address, operator: lc(e.operator) as Address, status: e.status };
  }

  async checkSigner(signer: Address, originHash: Hex, blockNumber?: bigint): Promise<SignerCheck> {
    const [code, s, e] = await rpc('checkSigner()', () =>
      this.client.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'checkSigner',
        args: [signer, originHash],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      }),
    );
    const name = CHECK[code];
    if (!name) throw new RpcError(`checkSigner returned unknown code ${code}`);
    return {
      code: name,
      signer: {
        agentId: s.agentId,
        releaseId: lc(s.releaseId) as Hex,
        originHash: lc(s.originHash) as Hex,
        operator: lc(s.operator) as Address,
        expiresAt: s.expiresAt,
        status: s.status,
      },
      endpoint: { agentId: e.agentId, payTo: lc(e.payTo) as Address, operator: lc(e.operator) as Address, status: e.status },
    };
  }

  authorizationState(asset: Address, payer: Address, nonce: Hex, blockNumber: bigint): Promise<boolean> {
    return rpc('authorizationState()', () =>
      this.client.readContract({ address: asset, abi: tokenAbi, functionName: 'authorizationState', args: [payer, nonce], blockNumber }),
    );
  }

  async account(address: Address, blockNumber: bigint): Promise<{ code: Hex; nonce: bigint; balance: bigint }> {
    const [code, nonce, balance] = await rpc('account state', () =>
      Promise.all([
        this.client.getCode({ address, blockNumber }),
        this.client.getTransactionCount({ address, blockNumber }),
        this.client.getBalance({ address, blockNumber }),
      ]),
    );
    return { code: lc(code ?? '0x') as Hex, nonce: BigInt(nonce), balance };
  }

  /**
   * The settlement of `(payer, nonce)` in `tx`, if its receipt holds both `AuthorizationUsed(payer, nonce)`
   * and `Transfer(payer → payTo, amount)` emitted by `asset` (SPEC §7 V11). Null when the receipt is
   * missing, reverted or lacks either log.
   */
  async settlementIn(tx: Hash, asset: Address, payer: Address, payTo: Address, amount: bigint, nonce: Hex): Promise<Settlement | null> {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: tx });
    } catch (e) {
      if ((e as Error).name === 'TransactionReceiptNotFoundError') return null;
      throw new RpcError(`receipt ${tx}: ${(e as Error).message.split('\n')[0]}`, { cause: e });
    }
    if (receipt.status !== 'success') return null;
    const fromAsset = receipt.logs.filter((l) => lc(l.address) === lc(asset));
    const events = parseEventLogs({ abi: tokenAbi, logs: fromAsset, strict: true });
    const used = events.some(
      (ev) => ev.eventName === 'AuthorizationUsed' && lc(ev.args.authorizer) === lc(payer) && lc(ev.args.nonce) === lc(nonce),
    );
    const transfer = events.some(
      (ev) =>
        ev.eventName === 'Transfer' && lc(ev.args.from) === lc(payer) && lc(ev.args.to) === lc(payTo) && ev.args.value === amount,
    );
    if (!used || !transfer) return null;
    const b = await this.block(receipt.blockNumber);
    return { tx, blockNumber: receipt.blockNumber, timestamp: b.timestamp };
  }

  /** `AuthorizationUsed(payer, nonce)` and `AuthorizationCanceled(payer, nonce)` logs from `asset` in `[from, to]`. */
  async authorizationLogs(asset: Address, payer: Address, nonce: Hex, from: bigint, to: bigint): Promise<{ used: Hash[]; canceled: Hash[] }> {
    const used: Hash[] = [];
    const canceled: Hash[] = [];
    for (let start = from; start <= to; start += LOG_CHUNK) {
      const end = start + LOG_CHUNK - 1n < to ? start + LOG_CHUNK - 1n : to;
      for (const event of [tokenAbi[2], tokenAbi[3]] as const) {
        const logs = await rpc('eth_getLogs', () =>
          this.client.getLogs({ address: asset, event, args: { authorizer: payer, nonce }, fromBlock: start, toBlock: end, strict: true }),
        );
        for (const l of logs) {
          if (lc(l.args.authorizer) !== lc(payer) || lc(l.args.nonce) !== lc(nonce)) continue;
          (event.name === 'AuthorizationUsed' ? used : canceled).push(l.transactionHash);
        }
      }
    }
    return { used, canceled };
  }

  /**
   * SPEC §7 V10 fallback: `checkSigner(signer, originHash)` as it stood at block `at` (timestamp `atTs`),
   * rebuilt from registry events ≤ `at` when the RPC no longer serves state that old (ADR-013).
   * Scans backwards in 1,000-block chunks. Throws RpcError if the logs can't be read.
   */
  async checkSignerFromEvents(
    signer: Address,
    originHash: Hex,
    at: bigint,
    atTs: bigint,
  ): Promise<{ code: CheckName; agentId?: bigint; releaseId?: Hex }> {
    let registered: { agentId: bigint; releaseId: Hex; originHash: Hex; operator: Address } | null = null;
    let expiresAt: bigint | null = null;
    let revoked = false;
    let endpoint: { active: boolean; agentId: bigint; operator: Address } | null = null;
    const releases = new Map<string, number>();
    const relKey = (a: bigint, r: Hex) => `${a}:${lc(r)}`;

    let to = at;
    const floor = at > MAX_REBUILD_BLOCKS ? at - MAX_REBUILD_BLOCKS : 0n;
    for (;;) {
      const from = to + 1n > LOG_CHUNK ? to + 1n - LOG_CHUNK : 0n;
      const raw = await rpc('eth_getLogs (registry)', () =>
        this.client.getLogs({ address: this.registry, fromBlock: from < floor ? floor : from, toBlock: to }),
      );
      const evs = parseEventLogs({ abi: registryAbi, logs: raw as Log[], strict: true }).sort((a, b) =>
        a.blockNumber === b.blockNumber ? b.logIndex! - a.logIndex! : a.blockNumber! > b.blockNumber! ? -1 : 1,
      );
      // Newest first: the first event seen for a key is its state at `at`.
      for (const ev of evs) {
        switch (ev.eventName) {
          case 'SignerRevoked':
            if (!registered && lc(ev.args.signer) === lc(signer)) revoked = true;
            break;
          case 'SignerRenewed':
            if (!registered && lc(ev.args.signer) === lc(signer) && expiresAt === null) expiresAt = ev.args.expiresAt;
            break;
          case 'SignerRegistered':
            if (!registered && lc(ev.args.signer) === lc(signer)) {
              registered = {
                agentId: ev.args.agentId,
                releaseId: ev.args.releaseId,
                originHash: lc(ev.args.originHash) as Hex,
                operator: lc(ev.args.operator) as Address,
              };
              if (expiresAt === null) expiresAt = ev.args.expiresAt;
            }
            break;
          case 'EndpointAdded':
            if (!endpoint && lc(ev.args.originHash) === lc(originHash))
              endpoint = { active: true, agentId: ev.args.agentId, operator: lc(ev.args.operator) as Address };
            break;
          case 'EndpointRetired':
            if (!endpoint && lc(ev.args.originHash) === lc(originHash))
              endpoint = { active: false, agentId: ev.args.agentId, operator: '0x0000000000000000000000000000000000000000' };
            break;
          case 'ReleaseApproved': {
            const k = relKey(ev.args.agentId, ev.args.releaseId);
            if (!releases.has(k)) releases.set(k, RELEASE_STATUS.Approved);
            break;
          }
          case 'ReleaseStatusChanged': {
            const k = relKey(ev.args.agentId, ev.args.releaseId);
            if (!releases.has(k)) releases.set(k, ev.args.to);
            break;
          }
          default:
            break;
        }
      }
      const releaseKnown = registered !== null && releases.has(relKey(registered.agentId, registered.releaseId));
      const endpointKnown = endpoint !== null || (registered !== null && lc(registered.originHash) !== lc(originHash));
      if (registered && releaseKnown && endpointKnown) break;
      if (from <= floor) {
        if (floor === 0n) break; // the whole chain was scanned
        throw new RpcError('event rebuild: no SignerRegistered within the scan bound');
      }
      to = from - 1n;
    }

    // SPEC §3.4 checkSigner order.
    if (!registered) return { code: 'UNKNOWN_SIGNER' };
    const s = { agentId: registered.agentId, releaseId: lc(registered.releaseId) as Hex };
    const code: CheckName = revoked
      ? 'SIGNER_REVOKED'
      : atTs >= (expiresAt ?? 0n)
        ? 'SIGNER_EXPIRED'
        : lc(registered.originHash) !== lc(originHash)
          ? 'ENDPOINT_MISMATCH'
          : !endpoint || !endpoint.active
            ? 'ENDPOINT_INACTIVE'
            : endpoint.agentId !== registered.agentId
              ? 'AGENT_MISMATCH'
              : endpoint.operator !== registered.operator
                ? 'OPERATOR_MISMATCH'
                : releases.get(relKey(registered.agentId, registered.releaseId)) !== RELEASE_STATUS.Approved
                  ? 'RELEASE_NOT_APPROVED'
                  : 'OK';
    return { code, ...s };
  }

  /** The owner's unverified `sourceRef` claim for a release (C2). Best effort: undefined if logs can't be read. */
  async sourceRef(agentId: bigint, releaseId: Hex): Promise<string | undefined> {
    try {
      const logs = await this.client.getLogs({
        address: this.registry,
        event: registryAbi.find((x) => x.type === 'event' && x.name === 'ReleaseApproved') as (typeof registryAbi)[number] & { type: 'event'; name: 'ReleaseApproved' },
        args: { agentId, releaseId },
        fromBlock: 'earliest',
        toBlock: 'latest',
        strict: true,
      });
      const last = logs.at(-1) as { args: { sourceRef?: string } } | undefined;
      return last?.args.sourceRef;
    } catch {
      return undefined;
    }
  }

  /**
   * SPEC §3.4 linkSelfAgent, re-evaluated at read time: "Self-verified owner" only if the link exists,
   * the Self NFT owner equals the current agent owner, and the human proof is present and fresh.
   * Any read failure is false.
   */
  async selfVerifiedOwner(agentId: bigint): Promise<boolean> {
    try {
      const selfId = await this.client.readContract({ address: this.registry, abi: registryAbi, functionName: 'selfLinks', args: [agentId] });
      if (selfId === 0n) return false;
      const [identity, self] = await Promise.all([
        this.client.readContract({ address: this.registry, abi: registryAbi, functionName: 'identityRegistry' }),
        this.client.readContract({ address: this.registry, abi: registryAbi, functionName: 'selfRegistry' }),
      ]);
      if (lc(self) === '0x0000000000000000000000000000000000000000') return false;
      const [owner, selfOwner, human, fresh] = await Promise.all([
        this.client.readContract({ address: identity, abi: identityAbi, functionName: 'ownerOf', args: [agentId] }),
        this.client.readContract({ address: self, abi: selfAbi, functionName: 'ownerOf', args: [selfId] }),
        this.client.readContract({ address: self, abi: selfAbi, functionName: 'hasHumanProof', args: [selfId] }),
        this.client.readContract({ address: self, abi: selfAbi, functionName: 'isProofFresh', args: [selfId] }),
      ]);
      return lc(owner) === lc(selfOwner) && human && fresh;
    } catch {
      return false;
    }
  }
}

export { ENDPOINT_STATUS, SIGNER_STATUS };
