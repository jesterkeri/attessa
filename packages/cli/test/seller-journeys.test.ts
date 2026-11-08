import { originHash } from '@attessa/core';
import { decodeFunctionData, parseTransaction, type Address, type Hex, type TransactionSerialized } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY_ABI, REGISTRY_ABI } from '../src/abi.ts';
import { hintPlan, parseAttestation } from '../src/attestation.ts';
import { IDENTITY, REGISTRY } from './fake-chain.ts';
import { expectFlows, flowsBlock, flowsOutput } from './flows.ts';
import { AGENT, ORIGIN, onboarded, sellerHost, world, type World } from './harness.ts';

// Seller journeys (FLOWS §6 J3, J4) and the other owner commands, against the CLI's fake chain.

const J3 = flowsBlock('### J3 bring a signer online');
const J4 = flowsBlock('### J4 revoke');
const SRC = 'https://github.com/acme/risk/commit/a1b2c3d';
const MEASUREMENTS_FROM = (w: World) =>
  JSON.stringify({ Measurements: { HashAlgorithm: 'Sha384 { ... }', PCR0: w.pcrs[0].toString('hex'), PCR1: w.pcrs[1].toString('hex'), PCR2: w.pcrs[2].toString('hex') } });
const KANIKO = `gcr.io/kaniko-project/executor@sha256:${'1'.repeat(64)}`;

let w: World;
let stops: Array<() => Promise<void>> = [];
beforeEach(() => {
  w = world();
});
afterEach(async () => {
  for (const s of stops) await s();
  stops = [];
});

const step = async (argv: string[], expectCode = 0) => {
  w.out.length = 0;
  w.err.length = 0;
  const code = await w.cli(...argv);
  if (code !== expectCode) throw new Error(`attessa ${argv.join(' ')} → ${code}\n${[...w.out, ...w.err].join('\n')}`);
  return [...w.out];
};

describe('seller: FLOWS §6 J3, one journey from a fresh wallet to a live signer', () => {
  it('every J3 command prints its FLOWS lines', async () => {
    // seller --help
    expectFlows(await step(['seller', '--help']), flowsOutput(J3, 'attessa seller --help'));

    // agent register: a fresh identity, minted to the wallet that sends it (agent 412 here).
    w.chain.owners.delete(AGENT);
    w.chain.nextAgentId = AGENT;
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    const reg = await step(['agent', 'register', '--name', 'Acme risk check', '--uri', 'https://raw.githubusercontent.com/acme/risk/main/docs/agent.json']);
    expectFlows(reg, flowsOutput(J3, 'attessa agent register'));
    expect(w.chain.owners.get(AGENT)).toBe(w.owner);
    const agentJson = JSON.parse(w.files.get('/srv/risk/docs/agent.json')!.toString());
    expect(agentJson).toEqual({
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: 'Acme risk check',
      description: '',
      services: [],
      x402Support: true,
      supportedTrust: ['reputation', 'tee-attestation'],
      registrations: [{ agentId: 412, agentRegistry: 'eip155:11142220:0x8004A818BFB912233c491871b3d84c89A494BD9e' }],
    });

    // enclave build (T15), on the host's repo
    w.env.ATTESSA_KANIKO_IMAGE = KANIKO;
    w.files.set('/srv/risk/enclave/Dockerfile', Buffer.from('FROM scratch'));
    w.runnerReply = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n', stderr: '' };
      if (cmd === 'git' && args[0] === 'log') return { code: 0, stdout: '1793000000\n', stderr: '' };
      if (cmd === 'git' && args[0] === 'remote') return { code: 0, stdout: 'git@github.com:acme/risk.git\n', stderr: '' };
      if (cmd === 'nitro-cli' && args[0] === 'build-enclave') return { code: 0, stdout: MEASUREMENTS_FROM(w), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    expectFlows(await step(['enclave', 'build']), flowsOutput(J3, 'attessa enclave build'));

    // release approve (T15)
    w.files.set('build/measurements.json', Buffer.from(MEASUREMENTS_FROM(w)));
    expectFlows(
      await step(['release', 'approve', '--agent', '412', '--from-build', 'build/measurements.json', '--source', SRC]),
      flowsOutput(J3, 'attessa release approve'),
      { slots: [['about 0.03 CELO', 'about [\\d.]+ CELO']] },
    );

    // endpoint add (T15). --operator names the EC2 wallet; without it T15 adds a muted "(operator …)" line.
    expectFlows(
      await step(['endpoint', 'add', '--agent', '412', '--origin', ORIGIN, '--pay-to', '0x00000000000000000000000000000000000000fe', '--operator', w.operator]),
      flowsOutput(J3, 'attessa endpoint add'),
      { slots: [['about 0.03 CELO', 'about [\\d.]+ CELO']] },
    );

    // enclave start (T15) on the host
    const h = await sellerHost(w);
    stops.push(h.stop);
    w.files.set('/srv/risk/build/risk.eif', Buffer.from('eif'));
    expectFlows(await step(['enclave', 'start', '--agent', '412', '--origin', ORIGIN, '--port', String(h.enclavePort)]), flowsOutput(J3, 'attessa enclave start'));

    // signer register (T15) from the operator wallet, 3 of 4 certificates already cached
    const doc = w.files.get('/srv/risk/att.bin')!;
    for (const c of hintPlan(parseAttestation(doc)).certs.slice(0, 3)) w.chain.certs.set(c.certHash, { notAfter: w.chain.timestamp + 3600n, parent: c.parentCertHash });
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    expectFlows(await step(['signer', 'register', '--agent', '412', '--fresh', '--seller-host', h.url, '--yes']), flowsOutput(J3, 'attessa signer register'), {
      slots: [
        ['about 8 CELO at', 'about [\\d.]+ CELO at'],
        ['about 4 CELO)', 'about [\\d.]+ CELO\\)'],
        ['Oct 26 14:00 UTC', '[A-Z][a-z]{2} \\d{1,2} \\d\\d:\\d\\d UTC'],
      ],
    });
    expect(w.chain.signers.get(h.enclave.signer)).toMatchObject({ agentId: AGENT, releaseId: w.rid, status: 1 });

    // J4 on the same chain: the owner revokes the release; its one live signer is named.
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    expectFlows(await step(['revoke', 'release', w.rid]), flowsOutput(J4, 'attessa revoke release'));
    expect(w.chain.releases.get(`${AGENT}:${w.rid}`)).toBe(3);
  });

  it('agent register without a key plans one register() from any wallet and sends nothing; the agent file is written', async () => {
    const lines = await step(['agent', 'register', '--name', 'Acme risk check', '--uri', 'https://example.org/agent.json']);
    expect(lines[0]).toBe("This creates your agent's public identity (ERC-8004) from this wallet. One transaction, about 0.05 CELO.  [register/cancel]");
    const data = lines[2]!.match(/^ {2}\(calldata (0x[0-9a-f]+)\)$/)![1] as Hex;
    const call = decodeFunctionData({ abi: IDENTITY_ABI, data });
    expect(call.functionName).toBe('register');
    expect(call.args).toEqual(['https://example.org/agent.json']);
    expect(lines.at(-1)).toMatch(/no ATTESSA_PRIVATE_KEY: nothing was sent/);
    expect(w.chain.sent).toHaveLength(0);
    expect(JSON.parse(w.files.get('/srv/risk/docs/agent.json')!.toString()).registrations).toEqual([]);
  });
});

describe('owner: FLOWS §6 J4 and the other owner commands', () => {
  const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
  const live = () => {
    onboarded(w);
    w.chain.approveRelease(AGENT, w.rid, SRC);
    w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
  };

  it('J4: revoke release names the build, its live signers and their origins, and sends one setReleaseStatus(…, Revoked)', async () => {
    live();
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    const lines = await step(['revoke', 'release', w.rid]);
    expectFlows(lines, flowsOutput(J4, 'attessa revoke release'));
    const tx = parseTransaction(w.chain.sent[0] as TransactionSerialized);
    expect(tx.to).toBe(REGISTRY);
    expect(decodeFunctionData({ abi: REGISTRY_ABI, data: tx.data! }).args).toEqual([AGENT, w.rid, 3]);
  });

  it('release revoke is the same command; a cancelled prompt sends nothing', async () => {
    live();
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    w.confirmAnswer = false;
    await step(['release', 'revoke', w.rid], 1);
    expect(w.chain.sent).toHaveLength(0);
    expect(w.chain.releases.get(`${AGENT}:${w.rid}`)).toBe(1);
  });

  it('release deprecate: Approved → Deprecated; a second deprecate is refused before sending', async () => {
    live();
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    const lines = await step(['release', 'deprecate', w.rid]);
    expect(lines.at(-1)).toMatch(/^Deprecated \(tx 0x[0-9a-f]{4}…[0-9a-f]{2}\)\.$/);
    expect(w.chain.releases.get(`${AGENT}:${w.rid}`)).toBe(2);
    await step(['release', 'deprecate', w.rid], 1);
    expect(w.err[0]).toBe(`Release ${w.rid.slice(0, 6)}…${w.rid.slice(-2)} is deprecated; that change isn't allowed.`);
  });

  it('an unknown release, and a release command from a wallet that is not the owner: FLOWS §8 lines', async () => {
    live();
    const other = `0x${'ab'.repeat(32)}` as Hex;
    await step(['revoke', 'release', other, '--agent', '412'], 1);
    expect(w.err).toEqual([`Agent 412 has no release ${other}.`, '`attessa status --agent 412` lists them.']);
    w.env.ATTESSA_PRIVATE_KEY = w.operatorKey;
    await step(['revoke', 'release', w.rid], 1);
    expect(w.err).toEqual([
      `Only agent 412's owner (${w.owner}) can do this; this command was signed by ${w.operator}.`,
      'Run it from the owner wallet (--keystore or ATTESSA_PRIVATE_KEY).',
    ]);
    expect(w.chain.sent).toHaveLength(0);
  });

  it('revoke signer: one revokeSigner, terminal', async () => {
    live();
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    const lines = await step(['revoke', 'signer', signer]);
    expect(lines[0]).toBe(`This stops signer ${signer.slice(0, 6)}…${signer.slice(-2)} for risk.example (agent 412) within 60 s. Revoking is permanent; the operator registers a new key to continue.  [revoke/cancel]`);
    expect(lines.at(-1)).toMatch(/^Revoked \(tx 0x[0-9a-f]{4}…[0-9a-f]{2}\)\.$/);
    expect(w.chain.signers.get(signer)!.status).toBe(2);
    await step(['revoke', 'signer', signer], 1);
    expect(w.err[0]).toBe(`Signer ${signer.slice(0, 6)}…${signer.slice(-2)} is already revoked.`);
  });

  it('endpoint retire: Active → Retired, from the owner', async () => {
    live();
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    const lines = await step(['endpoint', 'retire', '--origin', ORIGIN]);
    expect(lines.at(-1)).toMatch(/^Retired \(tx 0x[0-9a-f]{4}…[0-9a-f]{2}\)\.$/);
    expect(w.chain.endpoints.get(originHash(ORIGIN))!.status).toBe(2);
  });

  it('status --agent: releases, endpoints and signers with their states; --json carries .signer (T36)', async () => {
    live();
    const lines = await step(['status', '--agent', '412']);
    expect(lines[0]).toBe('Agent 412');
    expect(lines[1]).toBe(`  Release ${w.rid.slice(0, 6)}…${w.rid.slice(-2)}: Approved, owner says acme/risk @ a1b2c3d`);
    expect(lines[2]).toBe(`  Endpoint ${ORIGIN}: Active, pays 0x00000000000000000000000000000000000000fe, operator ${w.operator}`);
    expect(lines[3]).toMatch(new RegExp(`^ {2}Signer ${signer.slice(0, 6)}…${signer.slice(-2)}: Active, release 0x[0-9a-f]{4}…[0-9a-f]{2}, valid until `));
    const j = JSON.parse((await step(['status', '--agent', '412', '--json']))[0]!);
    expect(j.signer).toMatchObject({ signer, status: 'Active', expiresAt: (w.chain.timestamp + 604800n).toString() });
  });

  it('status --agent with nothing approved: the FLOWS empty state', async () => {
    const lines = await step(['status', '--agent', '412']);
    expect(lines).toEqual(['Agent 412', 'No releases yet. Approve one with `attessa release approve`.']);
  });

  it('agent transfer → wallet-sig (agent wallet, after the transfer) → set-wallet (cold owner): the wallet is set', async () => {
    const coldKey = generatePrivateKey();
    const cold = privateKeyToAccount(coldKey).address.toLowerCase() as Address;
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey; // the agent wallet owns the agent at first
    expect((await step(['agent', 'transfer', '--agent', '412', '--to', cold])).at(-1)).toMatch(/^Transferred \(tx 0x[0-9a-f]{4}…[0-9a-f]{2}\)\. Next, on the EC2 host: attessa agent wallet-sig\.$/);
    expect(w.chain.owners.get(AGENT)).toBe(cold);
    const sig = await step(['agent', 'wallet-sig', '--agent', '412', '--owner', cold]);
    const next = sig[1]!.match(/^Next, from the owner wallet: attessa agent set-wallet (.*)$/)![1]!.split(' ');
    expect(next.slice(0, 4)).toEqual(['--agent', '412', '--wallet', w.owner]);
    w.env.ATTESSA_PRIVATE_KEY = coldKey;
    expect((await step(['agent', 'set-wallet', ...next])).at(-1)).toMatch(/^Wallet set \(tx 0x[0-9a-f]{4}…[0-9a-f]{2}\)\.$/);
    expect(w.chain.agentWallets.get(AGENT)).toBe(w.owner);
    expect(parseTransaction(w.chain.sent.at(-1) as TransactionSerialized).to).toBe(IDENTITY);
  });

  it('wallet-sig before the transfer is refused (the signature binds the current owner)', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    const cold = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    await step(['agent', 'wallet-sig', '--agent', '412', '--owner', cold], 1);
    expect(w.err).toEqual([`Agent 412's owner is ${w.owner}, not ${cold}.`, 'Run this after attessa agent transfer has landed.']);
  });

  it('selflink with a Self ID that fails the registry checks: the FLOWS §8 line', async () => {
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    await step(['selflink', '--agent', '412', '--self-agent', '77'], 1);
    expect(w.err).toEqual([
      "Can't link Self Agent ID 77: it must be held by this wallet (Self's linked mode) and have a current human proof.",
      'Check it in the Self app, then run `attessa selflink` again.',
    ]);
    w.chain.selfOk.add(77n);
    expect((await step(['selflink', '--agent', '412', '--self-agent', '77'])).at(-1)).toMatch(/^Linked \(tx /);
    expect(w.chain.selfLinks.get(AGENT)).toBe(77n);
  });

  it('attessa gateway … hands its arguments to @attessa/gateway', async () => {
    const seen: string[][] = [];
    const code = await (await import('../src/index.ts')).run(['gateway', 'status', '--network', 'mainnet'], {
      ...w.deps(),
      gateway: async (args, out) => {
        seen.push(args);
        out('{"paused":false,"states":{}}\n');
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([['status', '--network', 'mainnet']]);
    expect(w.out).toEqual(['{"paused":false,"states":{}}']);
  });
});
