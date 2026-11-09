#!/usr/bin/env node
// Rehearsal phase 3c (local side): `attessa signer register` with a real AWS Nitro attestation (argv[2], fetched from the host)
// from the operator wallet; then every operator transaction's gas against the 16,777,215 per-transaction cap, and the cost at Forno's price.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertLocal, DIR, TAG, wallet, cli, state, rpc, pub, realGasPriceWei, celoCost } from './lib.mjs';
await assertLocal();
const att = process.argv[2];
const s = state(), A = s.agentId;
const operator = wallet('operator');
const work = join(DIR, 'work'); mkdirSync(work, { recursive: true });
copyFileSync(att, join(work, 'att.bin'));
const env = { ATTESSA_REGISTRY: process.env.REG || s.addrs.registry, LOOPS_ATTRIBUTION_TAG: TAG };
const clean = (t) => t.replace(/\(node:\d+\) ExperimentalWarning.*\n|\(Use `node --trace-warnings.*\n/g, '').trim();
const startBlock = BigInt(await rpc('eth_blockNumber'));
const t0 = Date.now();
const r = cli(['signer', 'register', '--agent', A, '--attestation', 'att.bin', '--yes'], { as: 'operator', cwd: work, env });
console.log(`$ attessa signer register --agent ${A} --attestation att.bin [as operator] -> exit ${r.code} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n${clean(r.text)}`);
const cap = 16_777_215n, price = await realGasPriceWei();
let total = 0n, n = 0, max = 0n;
const head = BigInt(await rpc('eth_blockNumber'));
for (let b = startBlock + 1n; b <= head; b++) {
  const blk = await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), true]);
  for (const tx of blk.transactions) {
    if (tx.from.toLowerCase() !== operator.address.toLowerCase()) continue;
    const rc = await rpc('eth_getTransactionReceipt', [tx.hash]);
    const g = BigInt(rc.gasUsed); total += g; n++; if (g > max) max = g;
    console.log(`tx ${tx.hash} to ${tx.to} status ${rc.status} gasUsed ${g} (${(Number(g) * 100 / Number(cap)).toFixed(1)}% of cap ${cap}) cost ${celoCost(g, price)} CELO at ${Number(price) / 1e9} gwei, calldata ${(tx.input.length - 2) / 2} bytes`);
  }
}
console.log(`${n} transactions, total gas ${total}, max single ${max} ${max > cap ? 'ABOVE THE CAP: LAUNCH BLOCKER' : 'under the cap'}, total cost ${celoCost(total, price)} CELO`);
const st = cli(['status', '--agent', A], { cwd: work, env });
console.log(`\n$ attessa status --agent ${A}\n${clean(st.text)}`);
process.exit(r.code ?? 1);
