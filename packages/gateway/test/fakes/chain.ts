import { randomBytes } from 'node:crypto';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { TOKEN_EVENTS, type AccountState, type BlockHeader, type Chain, type ChainLog, type CheckName, type Receipt, type SignerCheck } from '../../src/chain.ts';

export class Clock {
  t: number;
  constructor(t = Math.floor(Date.now() / 1000)) {
    this.t = t;
  }
  now = (): number => this.t;
}

const rand32 = (): Hex => `0x${randomBytes(32).toString('hex')}` as Hex;

function transferLog(asset: Address, from: Address, to: Address, value: bigint, tx: Hex, block: bigint): ChainLog {
  return {
    address: asset,
    topics: encodeEventTopics({ abi: TOKEN_EVENTS, eventName: 'Transfer', args: { from, to } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    transactionHash: tx,
    blockNumber: block,
  };
}

function authLog(event: 'AuthorizationUsed' | 'AuthorizationCanceled', asset: Address, authorizer: Address, nonce: Hex, tx: Hex, block: bigint): ChainLog {
  return {
    address: asset,
    topics: encodeEventTopics({ abi: TOKEN_EVENTS, eventName: event, args: { authorizer, nonce } }) as Hex[],
    data: '0x',
    transactionHash: tx,
    blockNumber: block,
  };
}

/**
 * An in-memory Celo: blocks stamped by the shared clock, per-block account state, an EIP-3009 token
 * (authorizationState, AuthorizationUsed / AuthorizationCanceled / Transfer logs, receipts), and a registry
 * `checkSigner`. `logLag` hides logs of the newest blocks from `getLogs`, like a lagging log index.
 */
export class FakeChain implements Chain {
  readonly blocks: BlockHeader[] = [];
  readonly logs: ChainLog[] = [];
  readonly receipts = new Map<string, Receipt>();
  readonly signers = new Map<string, SignerCheck>();
  private readonly accounts = new Map<string, Array<{ from: bigint; state: AccountState }>>();
  private readonly used = new Map<string, bigint>();
  readonly tokenBalance = new Map<string, bigint>();
  logLag = 0n;
  /** Number of blocks the receipt index lags behind the head. */
  receiptLag = 0n;
  rpcDown = false;
  calls = { checkSigner: 0, accountAt: 0, blockByNumber: 0, getLogs: 0, authorizationState: 0 };

  constructor(readonly clock: Clock) {
    for (let i = 0; i < 30; i++) this.mine(clock.t - 30 + i);
  }

  mine(timestamp = this.clock.t): BlockHeader {
    const b = { number: BigInt(this.blocks.length), hash: rand32(), timestamp: BigInt(timestamp) };
    this.blocks.push(b);
    return b;
  }

  /** Advances the clock by `s` seconds, mining one block per second. */
  advance(s: number): void {
    for (let i = 0; i < s; i++) {
      this.clock.t += 1;
      this.mine();
    }
  }

  head(): BlockHeader {
    return this.blocks[this.blocks.length - 1] as BlockHeader;
  }

  setAccount(address: Address, state: AccountState): void {
    const k = address.toLowerCase();
    const list = this.accounts.get(k) ?? [];
    list.push({ from: this.head().number, state });
    this.accounts.set(k, list);
  }

  private down(): void {
    if (this.rpcDown) throw new Error('rpc down');
  }

  async blockNumber(): Promise<bigint> {
    this.down();
    return this.head().number;
  }

  async latestBlock(): Promise<BlockHeader> {
    this.down();
    return this.head();
  }

  async blockByNumber(n: bigint): Promise<BlockHeader | null> {
    this.down();
    this.calls.blockByNumber++;
    return this.blocks[Number(n)] ?? null;
  }

  async accountAt(address: Address, block: bigint): Promise<AccountState> {
    this.down();
    this.calls.accountAt++;
    const list = this.accounts.get(address.toLowerCase()) ?? [];
    let s: AccountState = { code: '0x', nonce: 0n, balance: 0n };
    for (const e of list) if (e.from <= block) s = e.state;
    return s;
  }

  async checkSigner(_registry: Address, signer: Address): Promise<SignerCheck> {
    this.down();
    this.calls.checkSigner++;
    return this.signers.get(signer.toLowerCase()) ?? { code: 'UNKNOWN_SIGNER' as CheckName, agentId: 0n, releaseId: `0x${'00'.repeat(32)}` };
  }

  async getLogs(asset: Address, topics: Hex[], fromBlock: bigint): Promise<ChainLog[]> {
    this.down();
    this.calls.getLogs++;
    const visibleTo = this.head().number - this.logLag;
    return this.logs.filter(
      (l) =>
        l.address.toLowerCase() === asset.toLowerCase() &&
        l.blockNumber >= fromBlock &&
        l.blockNumber <= visibleTo &&
        topics.every((t, i) => t === null || l.topics[i]?.toLowerCase() === t.toLowerCase()),
    );
  }

  async receipt(tx: Hex): Promise<Receipt | null> {
    this.down();
    const r = this.receipts.get(tx.toLowerCase());
    if (!r || r.blockNumber > this.head().number - this.receiptLag) return null;
    return r;
  }

  async authorizationState(asset: Address, authorizer: Address, nonce: Hex, block: bigint): Promise<boolean> {
    this.down();
    this.calls.authorizationState++;
    const at = this.used.get(`${asset.toLowerCase()}:${authorizer.toLowerCase()}:${nonce.toLowerCase()}`);
    return at !== undefined && at <= block;
  }

  isUsed(asset: Address, authorizer: Address, nonce: Hex): boolean {
    return this.used.has(`${asset.toLowerCase()}:${authorizer.toLowerCase()}:${nonce.toLowerCase()}`);
  }

  balanceOf(asset: Address, who: Address): bigint {
    return this.tokenBalance.get(`${asset.toLowerCase()}:${who.toLowerCase()}`) ?? 0n;
  }

  fund(asset: Address, who: Address, value: bigint): void {
    this.tokenBalance.set(`${asset.toLowerCase()}:${who.toLowerCase()}`, this.balanceOf(asset, who) + value);
  }

  private tx(logs: ChainLog[], block: BlockHeader, hash: Hex): Hex {
    this.logs.push(...logs);
    this.receipts.set(hash, { transactionHash: hash, status: 'success', blockNumber: block.number, logs });
    return hash;
  }

  /** `transferWithAuthorization` mined in a new block: AuthorizationUsed + Transfer(from → to, value). */
  transferWithAuthorization(asset: Address, from: Address, to: Address, value: bigint, nonce: Hex): Hex {
    const key = `${asset.toLowerCase()}:${from.toLowerCase()}:${nonce.toLowerCase()}`;
    if (this.used.has(key)) throw new Error('FiatTokenV2: authorization is used or canceled');
    if (this.balanceOf(asset, from) < value) throw new Error('ERC20: transfer amount exceeds balance');
    const block = this.mine();
    this.used.set(key, block.number);
    this.tokenBalance.set(`${asset.toLowerCase()}:${from.toLowerCase()}`, this.balanceOf(asset, from) - value);
    this.fund(asset, to, value);
    const hash = rand32();
    return this.tx([authLog('AuthorizationUsed', asset, from, nonce, hash, block.number), transferLog(asset, from, to, value, hash, block.number)], block, hash);
  }

  /** `cancelAuthorization` mined in a new block. */
  cancelAuthorization(asset: Address, from: Address, nonce: Hex): Hex {
    const key = `${asset.toLowerCase()}:${from.toLowerCase()}:${nonce.toLowerCase()}`;
    if (this.used.has(key)) throw new Error('FiatTokenV2: authorization is used or canceled');
    const block = this.mine();
    this.used.set(key, block.number);
    const hash = rand32();
    return this.tx([authLog('AuthorizationCanceled', asset, from, nonce, hash, block.number)], block, hash);
  }

  /** An unrelated successful tx (no AuthorizationUsed, no Transfer). */
  unrelatedTx(): Hex {
    const block = this.mine();
    const hash = rand32();
    this.receipts.set(hash, { transactionHash: hash, status: 'success', blockNumber: block.number, logs: [] });
    return hash;
  }
}
