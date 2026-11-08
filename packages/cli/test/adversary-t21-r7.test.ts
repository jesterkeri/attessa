import { beforeEach, describe, expect, it } from 'vitest';
import { RpcError } from '../src/rpc.ts';
import { AGENT, world, type World } from './harness.ts';

// T21 adversary r7. `attessa agent register` from a wallet with no CELO for gas.
//
// FLOWS §5 row 26: `attessa agent register` | register agent identity | command + confirm | precondition
//   "wallet funded with CELO" | ... | On failure: `insufficient_gas_funds` / `rpc_unavailable`.
// FLOWS §9 "Recovery": every error row has one next action.
//
// A Celo node refuses a signed transaction whose sender can't pay for gas with a JSON-RPC error
// (-32000 "insufficient funds for gas * price + value: ..."). The CLI has no `insufficient_gas_funds` anywhere:
// the refusal falls through to "Unexpected error (RpcError)", machine code `unexpected`, with no next action.

let w: World;
beforeEach(() => {
  w = world();
});

/** `method` fails with `err()`; everything else is answered by the fake chain. */
function failAt(method: string, err: () => Error): void {
  const orig = w.chain.request.bind(w.chain);
  w.chain.request = async (m: string, p: unknown[]) => {
    if (m === method) throw err();
    return orig(m, p);
  };
}

const unfunded = () => new RpcError(-32000, 'insufficient funds for gas * price + value: balance 0, tx cost 52000000000000000, overshot 52000000000000000', undefined);

describe('T21 adversary r7: agent register from an unfunded wallet', () => {
  it('--json: the node refuses the signed tx for lack of CELO -> FLOWS §5 row 26 `insufficient_gas_funds`, not `unexpected`', async () => {
    w.chain.owners.delete(AGENT);
    w.chain.nextAgentId = AGENT;
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    failAt('eth_sendRawTransaction', unfunded);
    expect(await w.cli('agent', 'register', '--name', 'Acme risk check', '--uri', 'https://example.org/agent.json', '--yes', '--json')).toBe(1);
    expect(w.chain.sent).toHaveLength(0);
    const out = JSON.parse(w.out.at(-1)!);
    expect(out).toMatchObject({ ok: false, error: 'insufficient_gas_funds' });
  });

  it('text: the line names the missing CELO and gives one next action (FLOWS §9 Recovery), not "Unexpected error"', async () => {
    w.chain.owners.delete(AGENT);
    w.chain.nextAgentId = AGENT;
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    failAt('eth_sendRawTransaction', unfunded);
    expect(await w.cli('agent', 'register', '--name', 'Acme risk check', '--uri', 'https://example.org/agent.json', '--yes')).toBe(1);
    expect(w.err.join('\n')).not.toMatch(/^Unexpected error/);
    expect(w.err.join('\n')).toMatch(/CELO/);
    expect(w.err.length).toBeGreaterThanOrEqual(2);
  });
});
