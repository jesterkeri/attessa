import { beforeEach, expect, it } from 'vitest';
import { AGENT, attestation, onboarded, world, type World } from './harness.ts';
import { RpcError } from '../src/rpc.ts';

let w: World;
beforeEach(() => {
  w = world();
  onboarded(w);
  w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
});

it('signer register: a failing eth_getLogs surfaces rpc_unavailable (spec 1), not a silent fall back to the hash', async () => {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[] = []) => {
    if (m === 'eth_getLogs') throw new RpcError(-32000, 'boom', undefined);
    return orig(m, p);
  };
  const { doc } = attestation(w, {});
  w.files.set('att.bin', doc);
  const code = await w.cli('signer', 'register', '--agent', String(AGENT), '--attestation', 'att.bin', '--json');
  expect(w.out.join('\n') + w.err.join('\n')).toContain("Can't reach Celo");
});
