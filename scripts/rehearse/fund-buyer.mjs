#!/usr/bin/env node
// Rehearsal phase 4a: give the throwaway buyer USDC and USA₮ on the fork by impersonating a real holder (local anvil only).
import { parseAbi, getAddress } from '../../packages/core/node_modules/viem/_esm/index.js';
import { assertLocal, rpc, pub, wallet, walletClient, fund, USDC, USDT, save } from './lib.mjs';
await assertLocal();
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
const buyer = wallet('buyer');
await fund(buyer.address, 5);
const p = pub();
const head = BigInt(await rpc('eth_blockNumber'));
const forkBase = 82276163n;
import { toEventSelector } from '../../packages/core/node_modules/viem/_esm/index.js';
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
for (const [name, token, units] of [['USDC', USDC, 2_000_000n], ['USA₮', USDT, 2_000_000n]]) {
  // candidate holders from recent transfers at fork time (Forno read-only through the fork, windows <= 4000 blocks)
  const logs = await rpc('eth_getLogs', [{ address: token, topics: [TRANSFER], fromBlock: '0x' + (forkBase - 3500n).toString(16), toBlock: '0x' + forkBase.toString(16) }]);
  const cands = [...new Set(logs.map((l) => '0x' + l.topics[2].slice(26)))].slice(0, 60);
  let best = null;
  for (const c of cands) {
    const b = await p.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [getAddress(c)] });
    if (!best || b > best.b) best = { c: getAddress(c), b };
  }
  if (!best || best.b < units) throw new Error(`no holder of ${name} with >= ${units} atomic units among ${cands.length} recent recipients`);
  await rpc('anvil_impersonateAccount', [best.c]);
  await rpc('anvil_setBalance', [best.c, '0x56bc75e2d63100000']);
  const wc = walletClient(best.c);
  const hash = await wc.writeContract({ address: token, abi: erc20, functionName: 'transfer', args: [buyer.address, units], account: best.c });
  await p.waitForTransactionReceipt({ hash });
  await rpc('anvil_stopImpersonatingAccount', [best.c]);
  console.log(`${name}: moved ${units} atomic (${Number(units) / 1e6}) from real holder ${best.c} (had ${best.b}) to buyer ${buyer.address}; buyer balance now ${await p.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [buyer.address] })}`);
}
