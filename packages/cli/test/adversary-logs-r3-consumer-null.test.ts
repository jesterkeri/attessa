import { beforeEach, expect, it } from 'vitest';
import { AGENT, attestation, onboarded, world, type World } from './harness.ts';

let w: World;
beforeEach(() => {
  w = world();
  onboarded(w);
  w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
});

// A provider answering {"result":null} to eth_getLogs is a lie the code can see. Spec: it must be an RPC failure
// (rpc_unavailable, FLOWS section 8), not a crash and not a quiet success.
it('signer register: eth_getLogs answering null shows rpc_unavailable', async () => {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[] = []) => (m === 'eth_getLogs' ? (null as never) : orig(m, p));
  const { doc } = attestation(w, {});
  w.files.set('att.bin', doc);
  await w.cli('signer', 'register', '--agent', String(AGENT), '--attestation', 'att.bin', '--json');
  const shown = w.out.join('\n') + w.err.join('\n');
  expect(shown).toContain("Can't reach Celo");
});
