import { beforeEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness.ts';

// Review r1 finding 3: docs/agent.json keeps the minted agent id exact (SPEC §2: numbers that can exceed 2^53 are
// decimal strings). Safe integers stay JSON numbers, as the ERC-8004 registration file has them.

const FILE = '/srv/risk/docs/agent.json';
const URI = 'https://raw.githubusercontent.com/acme/risk/main/docs/agent.json';
let w: World;
beforeEach(() => {
  w = world();
  w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
});

const registerAs = async (id: bigint) => {
  w.chain.nextAgentId = id;
  expect(await w.cli('agent', 'register', '--name', 'Acme risk check', '--uri', URI, '--yes', '--json')).toBe(0);
  return w.files.get(FILE)!.toString();
};

describe('agent register writes the agent id exactly', () => {
  it('9007199254740993n (2^53 + 1) is the decimal string, not a rounded number', async () => {
    const text = await registerAs(9007199254740993n);
    expect(text).toContain('"agentId": "9007199254740993"');
    expect(JSON.parse(text).registrations[0].agentId).toBe('9007199254740993');
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ agentId: '9007199254740993' });
  });

  it('2^53 - 1 (the largest safe integer) stays a JSON number; 2^53 becomes a string', async () => {
    expect(JSON.parse(await registerAs(9007199254740991n)).registrations[0].agentId).toBe(9007199254740991);
    expect(JSON.parse(await registerAs(9007199254740992n)).registrations[0].agentId).toBe('9007199254740992');
  });

  it('a second register over a file with a string id still counts as registered (the only reader checks registrations.length)', async () => {
    await registerAs(9007199254740993n);
    expect(await w.cli('agent', 'register', '--name', 'Acme risk check', '--uri', URI, '--dry-run')).toBe(0);
    expect(JSON.parse(w.files.get(FILE)!.toString()).registrations[0].agentId).toBe('9007199254740993');
  });
});
