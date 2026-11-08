import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, world, type World } from './harness.ts';

// T21 adversary r55. `attessa agent register` writes docs/agent.json (with `registrations: []`) before it simulates,
// prompts or sends (packages/cli/src/commands/registry.ts, agentRegister). So a preview or a cancelled confirm
// overwrites a registration file the CLI wrote after a landed register: the agent id and its registry are wiped, and
// the file published at the agentURI no longer names the agent.
//
// FLOWS §10 (FLOWS.md:846): "Preview replaces undo. `--dry-run` on every write and on calls (stops before signing,
//   shows price and checks)."
// FLOWS §9 (FLOWS.md:833): "Confirms only where there is no undo and money or service is at stake: `agent register`,
//   ... Each prompt names the consequence". The register prompt names one transaction, not a rewritten file.
// SPEC §8: `attessa agent register` "writes `docs/agent.json`" with the registration it makes.

const FILE = '/srv/risk/docs/agent.json';
const URI = 'https://raw.githubusercontent.com/acme/risk/main/docs/agent.json';

let w: World;
beforeEach(() => {
  w = world();
  // A fresh wallet registers agent 412 for real (FLOWS §6 J3 step 1), so docs/agent.json names it.
  w.chain.owners.delete(AGENT);
  w.chain.nextAgentId = AGENT;
  w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
});

async function registered(): Promise<string> {
  expect(await w.cli('agent', 'register', '--name', 'Acme risk check', '--uri', URI, '--yes')).toBe(0);
  const before = w.files.get(FILE)!.toString();
  expect(JSON.parse(before).registrations).toEqual([{ agentId: 412, agentRegistry: expect.stringMatching(/^eip155:11142220:0x/) }]);
  w.out.length = 0;
  w.err.length = 0;
  return before;
}

describe('T21 adversary r55: a preview or a cancelled agent register changes nothing on disk', () => {
  it('agent register --dry-run after a landed register leaves docs/agent.json as it was', async () => {
    const before = await registered();
    const sent = w.chain.sent.length;
    expect(await w.cli('agent', 'register', '--name', 'Acme risk check', '--uri', URI, '--dry-run')).toBe(0);
    expect(w.out.at(-1)).toBe('  (dry run: nothing was sent)');
    expect(w.chain.sent).toHaveLength(sent);
    expect(w.files.get(FILE)!.toString()).toBe(before);
  });

  it('agent register cancelled at the [register/cancel] prompt leaves docs/agent.json as it was', async () => {
    const before = await registered();
    const sent = w.chain.sent.length;
    w.confirmAnswer = false;
    expect(await w.cli('agent', 'register', '--name', 'Acme risk check', '--uri', URI)).toBe(1);
    expect(w.chain.sent).toHaveLength(sent);
    expect(w.files.get(FILE)!.toString()).toBe(before);
  });
});
