// Records the JSON-RPC answers the explorer tests replay. Read-only: it calls only Celo Sepolia's public
// RPC (the CLI's default, packages/cli/src/context.ts), with eth_chainId, eth_blockNumber, eth_getLogs,
// eth_getBlockByNumber, eth_getBlockReceipts, eth_getTransactionReceipt and eth_call (decimals(), symbol()).
// It sends no transaction and needs no key.
//
// Run from the repo root: node packages/site/test/fixtures/capture.mjs
// It writes packages/site/test/fixtures/sepolia-*.json; each file says when and from where it was captured.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const RPC = 'https://forno.celo-sepolia.celo-testnet.org';
const USDC = '0x01c5c0122039549ad1493b8220cabedd739bc44e'; // packages/core/src/deployments.ts celo-sepolia usdc
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// AuthorizationUsed(address,bytes32): emitted by transferWithAuthorization (EIP-3009), the x402 settlement.
// Only used to prefer a settlement-shaped transfer; the explorer does not read it.
const AUTH_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
const here = dirname(fileURLToPath(import.meta.url));
const capturedAt = new Date().toISOString();

let id = 1;
async function call(method, params) {
  const request = { jsonrpc: '2.0', id: id++, method, params };
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const response = await res.json();
  return { request: { method, params }, response };
}
const result = async (m, p) => {
  const { response } = await call(m, p);
  if (response.error) throw new Error(`${m}: ${response.error.message}`);
  return response.result;
};
const pause = ms => new Promise(r => setTimeout(r, ms));

// The calls the explorer makes for one transaction, in its order, answers kept verbatim.
async function record(name, note, txHash) {
  const calls = [await call('eth_chainId', []), await call('eth_getTransactionReceipt', [txHash])];
  const receipt = calls[1].response.result;
  if (receipt && receipt.status === '0x1') calls.push(await call('eth_getBlockByNumber', [receipt.blockNumber, false]));
  const file = join(here, `sepolia-${name}.json`);
  writeFileSync(file, `${JSON.stringify({ note, capturedAt, rpc: RPC, txHash, calls }, null, 2)}\n`);
  console.log(`wrote ${file} (${txHash})`);
  return receipt;
}

const head = BigInt(await result('eth_blockNumber', []));
console.log(`head ${head}`);

// 1. USDC transfers: walk back from the head in windows Forno accepts.
const byTx = new Map();
let to = head, span = 5000n, windows = 0;
while (windows < 60 && to > 0n) {
  const from = to - span + 1n > 0n ? to - span + 1n : 0n;
  try {
    const logs = await result('eth_getLogs', [{ address: USDC, topics: [TRANSFER], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
    for (const l of logs) byTx.set(l.transactionHash, (byTx.get(l.transactionHash) ?? 0) + 1);
    windows++; to = from - 1n;
    if ([...byTx.values()].some(n => n > 1) && byTx.size >= 20) break;
  } catch (err) {
    if (span <= 100n) throw err;
    span /= 2n; console.log(`getLogs window -> ${span} (${err.message})`);
  }
  await pause(150);
}
console.log(`USDC transfers: ${byTx.size} txs, blocks ${to + 1n}..${head}`);
if (!byTx.size) throw new Error('no USDC transfer found on Celo Sepolia in the scanned range');

// Prefer a single transfer made by transferWithAuthorization (the shape of an x402 settlement).
let single = null;
for (const [tx, n] of byTx) {
  if (n !== 1) continue;
  const r = await result('eth_getTransactionReceipt', [tx]);
  if (r?.status !== '0x1') continue;
  single ??= tx;
  if (r.logs.some(l => l.address.toLowerCase() === USDC && l.topics[0] === AUTH_USED)) { single = tx; break; }
  await pause(100);
}
if (!single) throw new Error('no single USDC transfer found');
const settledReceipt = await record('settled', 'A real USDC transfer on Celo Sepolia: exactly one Transfer log of the pinned USDC, status 0x1. Found with eth_getLogs on the USDC address.', single);
console.log(`single: transferWithAuthorization ${settledReceipt.logs.some(l => l.topics[0] === AUTH_USED)}`);

const multi = [...byTx].find(([, n]) => n > 1)?.[0];
if (multi) await record('multiple', `A real Celo Sepolia transaction with ${byTx.get(multi)} Transfer logs of the pinned USDC. Found with eth_getLogs on the USDC address.`, multi);
else console.log('no transaction with more than one USDC transfer in the scanned range: sepolia-multiple.json not written');

// 2. A reverted transaction and a successful one that moves no USDC: walk recent blocks' receipts.
let reverted = null, plain = null;
// Blocks are read forty at a time: Forno answers each in about a second.
const receiptsOf = async n => {
  try { return await result('eth_getBlockReceipts', [`0x${n.toString(16)}`]); } catch {
    const block = await result('eth_getBlockByNumber', [`0x${n.toString(16)}`, false]);
    return Promise.all(block.transactions.map(tx => result('eth_getTransactionReceipt', [tx])));
  }
};
const SCAN = BigInt(process.env.CAPTURE_SCAN_BLOCKS ?? 3000); // widen it when no transaction in the last 3000 blocks reverted
for (let n = head; n > head - SCAN && !(reverted && plain); n -= 40n) {
  const batch = await Promise.all(Array.from({ length: 40 }, (_, i) => receiptsOf(n - BigInt(i)).catch(() => [])));
  for (const receipts of batch) for (const r of receipts ?? []) {
    if (!reverted && r.status === '0x0') reverted = r.transactionHash;
    const usdc = r.logs.some(l => l.address.toLowerCase() === USDC && l.topics[0] === TRANSFER);
    // Skip the chain's own deposit transactions (type 0x7e): a pasted settlement is never one.
    if (!plain && r.status === '0x1' && !usdc && r.type !== '0x7e') plain = r.transactionHash;
  }
  await pause(100);
}
if (reverted) await record('reverted', 'A real Celo Sepolia transaction that reverted (status 0x0). Found by reading recent blocks\' receipts.', reverted);
else console.log('no reverted transaction in the scanned blocks: sepolia-reverted.json not written');
if (plain) await record('notransfer', 'A real successful Celo Sepolia transaction with no Transfer log of the pinned USDC. Found by reading recent blocks\' receipts.', plain);
else console.log('no successful non-USDC transaction in the scanned blocks: sepolia-notransfer.json not written');

// 3. A hash with no transaction: sha256 of a fixed sentence, so it is reproducible and not chosen by hand.
const none = `0x${createHash('sha256').update('attessa site explorer fixture: a hash with no transaction').digest('hex')}`;
await record('notfound', 'A transaction hash that does not exist on Celo Sepolia: sha256("attessa site explorer fixture: a hash with no transaction"). The receipt answer is null.', none);

// 4. The token's own decimals() and symbol(), which explorer.js pins.
const token = { note: 'decimals() and symbol() of the pinned Celo Sepolia USDC, read with eth_call at the head block.', capturedAt, rpc: RPC, address: USDC, block: `0x${head.toString(16)}`,
  calls: [await call('eth_call', [{ to: USDC, data: '0x313ce567' }, `0x${head.toString(16)}`]), await call('eth_call', [{ to: USDC, data: '0x95d89b41' }, `0x${head.toString(16)}`])] };
writeFileSync(join(here, 'sepolia-usdc-token.json'), `${JSON.stringify(token, null, 2)}\n`);
console.log('wrote sepolia-usdc-token.json');
