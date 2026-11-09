#!/usr/bin/env node
// Rehearsal phase 2: `attessa agent register` from a throwaway agent wallet against the real ERC-8004 registry on the fork.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertLocal, RPC, DIR, TAG, wallet, fund, rpc, cli, save, state, realGasPriceWei, celoCost } from './lib.mjs';
await assertLocal();
const s = state();
const agent = wallet('agent');
await fund(agent.address, 5);
const work = join(DIR, 'work'); mkdirSync(work, { recursive: true, mode: 0o700 });
const env = { ATTESSA_REGISTRY: s.addrs.registry };
console.log('agent wallet', agent.address, '(throwaway)');
// 1. without the tag: must refuse before signing
let r = cli(['agent', 'register', '--name', 'Rehearsal agent', '--uri', 'https://seller.attessa.xyz/agent.json', '--yes'], { as: 'agent', cwd: work, env });
console.log(`\n$ attessa agent register (no LOOPS_ATTRIBUTION_TAG) -> exit ${r.code}\n${r.text.trim()}`);
// 2. with the tag
const t0 = Date.now();
r = cli(['agent', 'register', '--name', 'Rehearsal agent', '--uri', 'https://seller.attessa.xyz/agent.json', '--yes', '--json'], { as: 'agent', cwd: work, env: { ...env, LOOPS_ATTRIBUTION_TAG: TAG } });
console.log(`\n$ attessa agent register --network local --rpc ${RPC} (tag set) -> exit ${r.code} (${Date.now() - t0} ms)\n${r.text.trim()}`);
const j = JSON.parse(r.stdout.trim().split('\n').pop());
const tx = await rpc('eth_getTransactionByHash', [j.tx]);
const rc = await rpc('eth_getTransactionReceipt', [j.tx]);
const hex = Buffer.from(TAG).toString('hex');
console.log(`\ntx ${j.tx} to ${tx.to}, input ${tx.input.length / 2 - 1} bytes, ends with ${tx.input.slice(-32)}`);
console.log(`tag ${TAG} (hex ${hex}) present in calldata: ${tx.input.includes(hex)}; ERC-8021 marker 8021x8 at end: ${tx.input.endsWith('80218021'.repeat(4))}`);
const price = await realGasPriceWei();
console.log(`gas used ${parseInt(rc.gasUsed, 16)} = ${celoCost(parseInt(rc.gasUsed, 16), price)} CELO at ${Number(price) / 1e9} gwei`);
console.log('agent.json:', readFileSync(join(work, 'docs/agent.json'), 'utf8').replace(/\n\s*/g, ' '));
save({ agentId: j.agentId });
const st = cli(['status', '--agent', j.agentId], { cwd: work, env });
console.log(`\n$ attessa status --agent ${j.agentId} -> exit ${st.code}\n${st.text.trim()}`);
