// Shared helpers for the mainnet rehearsal (scripts/rehearse/*). Local anvil fork only.
// Safety: every RPC that receives a send must be http://127.0.0.1:<port> and answer anvil_nodeInfo.
// Keys are generated fresh with `cast wallet new`, kept mode 0600 in a mode 0700 dir, never printed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http, defineChain, parseEther, formatEther } from '../../packages/core/node_modules/viem/_esm/index.js';
import { privateKeyToAccount } from '../../packages/core/node_modules/viem/_esm/accounts/index.js';

export const DIR = process.env.REHEARSE_DIR || '/tmp/attessa-rehearse';
export const PORT = Number(process.env.REHEARSE_PORT || 18546);
export const RPC = `http://127.0.0.1:${PORT}`;
export const TAG = 'celo_rehearsal';
export const IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const SELF = '0xaC3DF9ABf80d0F5c020C06B04Cced27763355944';
export const USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
export const USDT = '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771';
export const chain = defineChain({ id: 42220, name: 'celo-fork', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

export async function assertLocal(url = RPC) {
  const u = new URL(url);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') throw new Error(`refusing: send RPC ${url} is not http://127.0.0.1`);
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }) });
  const j = await r.json();
  if (!j.result) throw new Error(`refusing: ${url} does not answer anvil_nodeInfo`);
  return j.result;
}
export async function rpc(method, params = [], url = RPC) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
export const pub = () => createPublicClient({ chain, transport: http(RPC) });

export function ensureDir() { mkdirSync(DIR, { recursive: true, mode: 0o700 }); chmodSync(DIR, 0o700); mkdirSync(join(DIR, 'keys'), { recursive: true, mode: 0o700 }); chmodSync(join(DIR, 'keys'), 0o700); }
/** Fresh key via `cast wallet new`; reused if already generated this run. Returns the account, never prints the key. */
export function wallet(name) {
  ensureDir();
  const f = join(DIR, 'keys', name);
  if (!existsSync(f)) {
    const out = JSON.parse(execFileSync('cast', ['wallet', 'new', '--json'], { encoding: 'utf8' }));
    writeFileSync(f, (out.data ?? out)[0].private_key, { mode: 0o600 });
  }
  const key = readFileSync(f, 'utf8').trim();
  return { account: privateKeyToAccount(key), key, address: privateKeyToAccount(key).address };
}
export const walletClient = (account) => createWalletClient({ account, chain, transport: http(RPC) });
export async function fund(addr, celo) { await rpc('anvil_setBalance', [addr, '0x' + parseEther(String(celo)).toString(16)]); }
export async function mine() { await rpc('evm_mine'); }

export async function realGasPriceWei() {
  const r = await fetch('https://forno.celo.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }) });
  return BigInt((await r.json()).result);
}
export const celoCost = (gas, price) => formatEther(BigInt(gas) * price);
export function cleanupKeys() { rmSync(join(DIR, 'keys'), { recursive: true, force: true }); }
export const state = () => { const f = join(DIR, 'state.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; };
export const save = (o) => writeFileSync(join(DIR, 'state.json'), JSON.stringify({ ...state(), ...o }, null, 2), { mode: 0o600 });
