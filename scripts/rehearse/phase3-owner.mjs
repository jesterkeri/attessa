#!/usr/bin/env node
// Rehearsal phase 3b (local side): the T31 owner sequence on the fork with the real CLI:
// agent transfer -> wallet-sig -> set-wallet -> release approve (real PCRs) -> endpoint add.
// Needs the measurements.json copied from the host as argv[2], the commit sha as argv[3], optional origin argv[4].
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertLocal, DIR, TAG, wallet, fund, cli, state, save } from './lib.mjs';
await assertLocal();
const [meas, sha, originArg] = [process.argv[2], process.argv[3], process.argv[4]];
const origin = originArg || 'https://seller.attessa.xyz';
const s = state();
const A = s.agentId, REG = s.registryForPhase3 || s.addrs.registry;
const owner = wallet('owner'), operator = wallet('operator'), payto = wallet('payto'), agent = wallet('agent');
await fund(owner.address, 2); await fund(operator.address, 20);
const work = join(DIR, 'work'); mkdirSync(work, { recursive: true });
copyFileSync(meas, join(work, 'measurements.json'));
const env = { ATTESSA_REGISTRY: REG, LOOPS_ATTRIBUTION_TAG: TAG };
const clean = (t) => t.replace(/\(node:\d+\) ExperimentalWarning.*\n|\(Use `node --trace-warnings.*\n/g, '').trim();
const step = (title, args, as) => {
  const t0 = Date.now();
  const r = cli([...args, '--yes'], { as, cwd: work, env });
  console.log(`\n$ attessa ${args.join(' ')}   [as ${as}]  -> exit ${r.code} (${Date.now() - t0} ms)\n${clean(r.text)}`);
  if (r.code !== 0) { console.log(`STOP at ${title}`); process.exit(1); }
  return r;
};
console.log(`registry ${REG}\nagent ${agent.address}\nowner ${owner.address}\noperator ${operator.address}\npayTo ${payto.address}\n(all throwaway)`);
step('transfer', ['agent', 'transfer', '--agent', A, '--to', owner.address], 'agent');
let r = step('wallet-sig', ['agent', 'wallet-sig', '--agent', A, '--owner', owner.address, '--json'], 'agent');
const sig = JSON.parse(r.stdout.trim().split('\n').pop());
step('set-wallet', ['agent', 'set-wallet', '--agent', A, '--wallet', sig.newWallet, '--sig', sig.signature, '--deadline', sig.deadline], 'owner');
step('release approve', ['release', 'approve', '--agent', A, '--from-build', 'measurements.json', '--source', `https://github.com/jesterkeri/attessa/commit/${sha.slice(0, 7)}`], 'owner');
step('endpoint add', ['endpoint', 'add', '--agent', A, '--origin', origin, '--pay-to', payto.address, '--operator', operator.address], 'owner');
const st = cli(['status', '--agent', A], { cwd: work, env });
console.log(`\n$ attessa status --agent ${A}\n${clean(st.text)}`);
save({ origin, operator: operator.address, owner: owner.address, payto: payto.address });
