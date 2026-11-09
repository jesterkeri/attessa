#!/usr/bin/env node
// Rehearsal phase 4b: the real `attessa call` as a throwaway buyer against the real enclave behind seller-host + gateway.
//   node scripts/rehearse/phase4-buy.mjs [asset: usdc|usat] [gatewayPort=8080]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAbi } from '../../packages/core/node_modules/viem/_esm/index.js';
import { assertLocal, DIR, TAG, USDC, USDT, ROOT, wallet, cli, state, pub } from './lib.mjs';
await assertLocal();
const [assetName = 'usdc', port = '8080'] = process.argv.slice(2);
const token = assetName === 'usat' ? USDT : USDC;
const s = state(), buyer = wallet('buyer');
const bal = parseAbi(['function balanceOf(address) view returns (uint256)']);
const b = async (who) => pub().readContract({ address: token, abi: bal, functionName: 'balanceOf', args: [who] });
const home = join(DIR, 'buyer-home'); mkdirSync(home, { recursive: true, mode: 0o700 });
const env = { ATTESSA_REGISTRY: s.addrs.registry, ATTESSA_DATA_DIR: home, HOME: home, LOOPS_ATTRIBUTION_TAG: TAG, REHEARSE_ORIGIN_HOST: new URL(s.origin).hostname, REHEARSE_ORIGIN_TARGET: `http://127.0.0.1:${port}`, NODE_OPTIONS: `--import ${join(ROOT, 'scripts/rehearse/origin-map.mjs')}` };
const clean = (t) => t.replace(/\(node:\d+\) ExperimentalWarning.*\n|\(Use `node --trace-warnings.*\n/g, '').trim();
const before = { buyer: await b(buyer.address), payTo: await b(s.payto) };
console.log(`${assetName.toUpperCase()} before: buyer ${before.buyer}, seller payTo ${before.payTo}`);
const body = join(DIR, 'request-allow.json');
const t0 = Date.now();
const r = cli(['call', `${s.origin}/v1/evaluate`, '--body', body, '--max-amount', '0.05', '--asset', assetName, '--json', '--yes'], { as: 'buyer', cwd: DIR, env });
console.log(`$ attessa call ${s.origin}/v1/evaluate --body request-allow.json --max-amount 0.05 --asset ${assetName} -> exit ${r.code} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n${clean(r.text)}`);
const after = { buyer: await b(buyer.address), payTo: await b(s.payto) };
console.log(`${assetName.toUpperCase()} after:  buyer ${after.buyer} (delta ${after.buyer - before.buyer}), seller payTo ${after.payTo} (delta ${after.payTo - before.payTo})`);
process.exit(r.code ?? 1);
