import { beforeEach, expect, it } from 'vitest';
import { AGENT, attestation, onboarded, world, type World } from './harness.ts';

let w: World;
beforeEach(() => {
  w = world();
  onboarded(w);
  w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
});

// A list whose items are malformed is a detectable lie. Spec: rpc_unavailable (FLOWS section 8), never an unexpected crash.
const bad: Array<[string, unknown]> = [
  ['a null item', [null]],
  ['an empty object', [{}]],
  ['an item without topics', [{ data: '0x', blockNumber: '0x1' }]],
  ['an item with empty topics', [{ topics: [], data: '0x' }]],
];

it.each(bad)('signer register: eth_getLogs list with %s shows rpc_unavailable', async (_n, ans) => {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[] = []) => (m === 'eth_getLogs' ? (ans as never) : orig(m, p));
  const { doc } = attestation(w, {});
  w.files.set('att.bin', doc);
  await w.cli('signer', 'register', '--agent', String(AGENT), '--attestation', 'att.bin', '--json');
  expect(w.out.join('\n') + w.err.join('\n')).toContain("Can't reach Celo");
});

it.each(bad)('status --agent: eth_getLogs list with %s shows rpc_unavailable', async (_n, ans) => {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[] = []) => (m === 'eth_getLogs' ? (ans as never) : orig(m, p));
  delete w.env.ATTESSA_PRIVATE_KEY;
  await w.cli('status', '--agent', String(AGENT), '--json');
  expect(w.out.join('\n') + w.err.join('\n')).toContain("Can't reach Celo");
});

it('signer register: a log whose data does not decode shows rpc_unavailable', async () => {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[] = []) => {
    if (m !== 'eth_getLogs') return orig(m, p);
    const rows = (await orig(m, p)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...r, data: '0x01' })) as never;
  };
  const { doc } = attestation(w, {});
  w.files.set('att.bin', doc);
  await w.cli('signer', 'register', '--agent', String(AGENT), '--attestation', 'att.bin', '--json');
  expect(w.out.join('\n') + w.err.join('\n')).toContain("Can't reach Celo");
});

it('status --agent: a log whose data does not decode shows rpc_unavailable', async () => {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[] = []) => {
    if (m !== 'eth_getLogs') return orig(m, p);
    const rows = (await orig(m, p)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...r, data: '0x01' })) as never;
  };
  delete w.env.ATTESSA_PRIVATE_KEY;
  await w.cli('status', '--agent', String(AGENT), '--json');
  expect(w.out.join('\n') + w.err.join('\n')).toContain("Can't reach Celo");
});
