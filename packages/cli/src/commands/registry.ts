import { resolve } from 'node:path';
import { normalizeOrigin, originHash } from '@attessa/core';
import {
  decodeEventLog,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import { AGENT_WALLET_SET_TYPES, ENDPOINT_STATUS, IDENTITY_ABI, REGISTRY_ABI, REGISTRY_EVENTS, RELEASE_STATUS, SIGNER_STATUS } from '../abi.ts';
import { connect, type Chain, type Deps, type Global } from '../context.ts';
import { CliError, ERR, OWN, OWNERR, celo, host, safe, short, sourceLabel, utcShort } from '../copy.ts';
import { revertToError, type RevertContext } from '../reverts.ts';
import { gasPrice, head, planOrSend, read, simulate, type Revert, type Step } from '../tx.ts';
import { ownerOf, parseAgent } from './owner.ts';

/** Owner commands beyond T15's (SPEC §8): agent register/transfer/wallet-sig/set-wallet, selflink, release deprecate|revoke, revoke signer, endpoint retire, and `status --agent`. */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const ZERO: Address = '0x0000000000000000000000000000000000000000';

type EventName = 'ReleaseApproved' | 'EndpointAdded' | 'SignerRegistered';

/** Registry events matching the indexed `args` (null = any), from block 0. */
async function events(c: Chain, eventName: EventName, args: Record<string, unknown>): Promise<Array<{ args: Record<string, any>; blockNumber: bigint }>> {
  const topics = encodeEventTopics({ abi: REGISTRY_EVENTS, eventName, args } as never);
  let logs: Array<{ topics: Hex[]; data: Hex; blockNumber?: string }>;
  try {
    logs = (await c.rpc.request('eth_getLogs', [{ address: c.registry, topics, fromBlock: '0x0', toBlock: 'latest' }])) as typeof logs;
  } catch {
    throw ERR.rpcUnavailable(c.rpc.url);
  }
  return logs.map((l) => ({
    args: decodeEventLog({ abi: REGISTRY_EVENTS, eventName, topics: l.topics as [Hex, ...Hex[]], data: l.data }).args as Record<string, any>,
    blockNumber: BigInt(l.blockNumber ?? 0),
  }));
}

async function originOf(c: Chain, oh: Hex): Promise<string | undefined> {
  return (await events(c, 'EndpointAdded', { originHash: oh })).at(-1)?.args.origin as string | undefined;
}

/** The sender: the env key's address, or the owner when only planning (no key). */
function sender(c: Chain, owner: Address): Address {
  return (c.account?.address.toLowerCase() as Address | undefined) ?? owner;
}

/** Revert names these commands reach that T15's mapping doesn't name in FLOWS words. */
function onRevert(rc: RevertContext, extra: Partial<Record<string, () => CliError>>) {
  return (r: Revert | null, message: string) => extra[r?.name ?? '']?.() ?? revertToError(r, message, rc);
}

async function write(
  c: Chain,
  g: Global,
  deps: Deps,
  o: { from: Address; step: Step; yesWord: string; prompt: (cost: string) => string; rc: RevertContext; extra?: Partial<Record<string, () => CliError>>; done: (tx: Hex, logs: Array<{ address: Address; topics: Hex[]; data: Hex }>) => void },
): Promise<number> {
  const fail = onRevert(o.rc, o.extra ?? {});
  const sim = await simulate(c, o.from, o.step);
  if (!sim.ok) throw fail(sim.revert, sim.message);
  deps.io.out(o.prompt(celo(sim.gas * (await gasPrice(c)))));
  const r = await planOrSend(c, g, deps, { yesWord: o.yesWord, steps: [o.step], from: o.from, simulations: [sim] }, fail, (_i, s) => o.done(s.hash, s.logs));
  return r === 'cancelled' ? 1 : 0;
}

function needAgent(v: string | undefined): bigint {
  return parseAgent(v);
}

// ---------------------------------------------------------------- agent register (J3)

export async function agentRegister(g: Global, deps: Deps, o: { name?: string | undefined; description?: string | undefined; uri?: string | undefined }): Promise<number> {
  if (!o.name) throw ERR.usage('--name is required, like --name "Acme risk check".');
  if (!o.uri) throw ERR.usage('--uri <agentURI> is required: where docs/agent.json will be published.');
  const c = await connect(g, deps);
  const identity = ((await read(c, c.registry, REGISTRY_ABI, 'identityRegistry', [])) as Address).toLowerCase() as Address;
  // ERC-8004 registration file (SPEC §8). `services` lists endpoints; there are none before `endpoint add`.
  const file = resolve(deps.cwd, 'docs/agent.json');
  const doc = (registrations: Array<{ agentId: number; agentRegistry: string }>) =>
    `${JSON.stringify(
      {
        type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        name: o.name,
        description: o.description ?? '',
        services: [],
        x402Support: true,
        supportedTrust: ['reputation', 'tee-attestation'],
        registrations,
      },
      null,
      2,
    )}\n`;
  deps.writeFile(file, doc([]));
  const from = (c.account?.address.toLowerCase() as Address | undefined) ?? ZERO;
  const step: Step = { label: 'register', to: identity, data: encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'register', args: [o.uri] }) };
  return write(c, g, deps, {
    from,
    step,
    yesWord: 'register',
    prompt: OWN.registerPrompt,
    rc: { agent: 'new', from },
    done: (tx, logs) => {
      const minted = logs
        .filter((l) => l.address === identity)
        .map((l) => {
          try {
            return decodeEventLog({ abi: IDENTITY_ABI, eventName: 'Transfer', topics: l.topics as [Hex, ...Hex[]], data: l.data }).args;
          } catch {
            return null;
          }
        })
        .find((a) => a && a.from === ZERO && a.to.toLowerCase() === from);
      if (!minted) throw new CliError('no_agent_id', `The registration (tx ${tx}) minted no agent to ${from}.`, 'Check the tx on a Celo explorer.');
      const agent = minted.tokenId.toString();
      deps.writeFile(file, doc([{ agentId: Number(minted.tokenId), agentRegistry: `eip155:${c.chainId}:${getAddress(identity)}` }]));
      deps.io.out(OWN.registered(agent, tx));
      deps.io.data?.({ agentId: agent, tx, agentFile: file });
    },
  });
}

// ---------------------------------------------------------------- agent transfer / wallet-sig / set-wallet (SPEC §8, T31)

export async function agentTransfer(g: Global, deps: Deps, o: { agent?: string | undefined; to?: string | undefined }): Promise<number> {
  const agentId = needAgent(o.agent);
  if (!o.to || !ADDRESS.test(o.to)) throw ERR.usage('--to <cold owner address> is required.');
  const c = await connect(g, deps);
  const agent = agentId.toString();
  const owner = await ownerOf(c, agentId);
  const from = sender(c, owner);
  if (from !== owner) throw ERR.notOwner(agent, owner, from);
  const identity = (await read(c, c.registry, REGISTRY_ABI, 'identityRegistry', [])) as Address;
  const to = getAddress(o.to);
  const step: Step = { label: 'transferFrom', to: identity, data: encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'transferFrom', args: [getAddress(owner), to, agentId] }) };
  return write(c, g, deps, {
    from,
    step,
    yesWord: 'transfer',
    prompt: () => OWN.transferPrompt(agent, to.toLowerCase()),
    rc: { agent, from, owner },
    done: (tx) => deps.io.out(OWN.transferred(tx)),
  });
}

async function walletDomain(c: Chain, identity: Address) {
  const d = (await read(c, identity, IDENTITY_ABI, 'eip712Domain', [])) as readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]];
  return { name: d[1], version: d[2], chainId: Number(d[3]), verifyingContract: d[4] };
}

export async function agentWalletSig(g: Global, deps: Deps, o: { agent?: string | undefined; owner?: string | undefined; deadline?: string | undefined }): Promise<number> {
  const agentId = needAgent(o.agent);
  if (!o.owner || !ADDRESS.test(o.owner)) throw ERR.usage('--owner <cold owner address> is required.');
  const secs = o.deadline === undefined ? 300n : DEC.test(o.deadline) ? BigInt(o.deadline) : -1n;
  if (secs < 1n || secs > 300n) throw ERR.usage('--deadline is seconds from now, 1 to 300 (the identity registry accepts at most 5 minutes).');
  const c = await connect(g, deps);
  if (!c.account) throw ERR.usage('agent wallet-sig signs with the agent wallet: set ATTESSA_PRIVATE_KEY to it.');
  const agent = agentId.toString();
  const owner = await ownerOf(c, agentId);
  // The signed struct binds the current owner (SPEC §8): signing before the transfer gives a signature set-wallet rejects.
  if (owner !== o.owner.toLowerCase()) throw new CliError('not_owner', `Agent ${agent}'s owner is ${owner}, not ${o.owner.toLowerCase()}.`, 'Run this after attessa agent transfer has landed.'); // not in FLOWS
  const identity = (await read(c, c.registry, REGISTRY_ABI, 'identityRegistry', [])) as Address;
  const deadline = (await head(c)).timestamp + secs;
  const signature = await c.account.signTypedData({
    domain: await walletDomain(c, identity),
    types: AGENT_WALLET_SET_TYPES,
    primaryType: 'AgentWalletSet',
    message: { agentId, newWallet: c.account.address, owner: getAddress(owner), deadline },
  });
  for (const l of OWN.walletSig(agent, c.account.address.toLowerCase(), signature, deadline.toString(), utcShort(deadline))) deps.io.out(l);
  deps.io.data?.({ agentId: agent, newWallet: c.account.address.toLowerCase(), owner, deadline: deadline.toString(), signature });
  return 0;
}

export async function agentSetWallet(
  g: Global,
  deps: Deps,
  o: { agent?: string | undefined; wallet?: string | undefined; sig?: string | undefined; deadline?: string | undefined },
): Promise<number> {
  const agentId = needAgent(o.agent);
  // The signed struct contains the new wallet, so it can't be recovered from the signature alone: --wallet names it.
  if (!o.wallet || !ADDRESS.test(o.wallet)) throw ERR.usage('--wallet must be the agent wallet address attessa agent wallet-sig printed.');
  if (!o.sig || !/^0x[0-9a-fA-F]{130}$/.test(o.sig)) throw ERR.usage('--sig must be the signature attessa agent wallet-sig printed.');
  if (!o.deadline || !DEC.test(o.deadline)) throw ERR.usage('--deadline must be the deadline attessa agent wallet-sig printed.');
  const deadline = BigInt(o.deadline);
  const wallet = getAddress(o.wallet);
  const c = await connect(g, deps);
  const agent = agentId.toString();
  const owner = await ownerOf(c, agentId);
  const from = sender(c, owner);
  if (from !== owner) throw ERR.notOwner(agent, owner, from);
  if ((await head(c)).timestamp > deadline) throw new CliError('deadline_passed', 'The signature expired.', 'Run attessa agent wallet-sig again on the EC2 host.'); // not in FLOWS
  const identity = (await read(c, c.registry, REGISTRY_ABI, 'identityRegistry', [])) as Address;
  const signedBy = await recoverTypedDataAddress({
    domain: await walletDomain(c, identity),
    types: AGENT_WALLET_SET_TYPES,
    primaryType: 'AgentWalletSet',
    message: { agentId, newWallet: wallet, owner: getAddress(owner), deadline },
    signature: o.sig as Hex,
  }).catch(() => null);
  if (signedBy !== wallet) {
    // not in FLOWS
    throw new CliError('bad_signature', `This signature isn't ${wallet.toLowerCase()}'s for agent ${agent}, owner ${owner} and deadline ${deadline}.`, 'Run attessa agent wallet-sig again after the transfer.');
  }
  const step: Step = {
    label: 'setAgentWallet',
    to: identity,
    data: encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'setAgentWallet', args: [agentId, wallet, deadline, o.sig as Hex] }),
  };
  return write(c, g, deps, {
    from,
    step,
    yesWord: 'set',
    prompt: () => OWN.setWalletPrompt(agent, wallet.toLowerCase()),
    rc: { agent, from, owner },
    done: (tx) => deps.io.out(OWN.walletSet(tx)),
  });
}

// ---------------------------------------------------------------- selflink

export async function selflink(g: Global, deps: Deps, o: { agent?: string | undefined; selfAgent?: string | undefined }): Promise<number> {
  const agentId = needAgent(o.agent);
  if (!o.selfAgent || !DEC.test(o.selfAgent)) throw ERR.usage('--self-agent <Self Agent ID> is required.');
  const sid = o.selfAgent;
  const c = await connect(g, deps);
  const agent = agentId.toString();
  const owner = await ownerOf(c, agentId);
  const from = sender(c, owner);
  if (from !== owner) throw ERR.notOwner(agent, owner, from);
  const step: Step = { label: 'linkSelfAgent', to: c.registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'linkSelfAgent', args: [agentId, BigInt(sid)] }) };
  return write(c, g, deps, {
    from,
    step,
    yesWord: 'link',
    prompt: () => OWN.selflinkPrompt(agent, sid),
    rc: { agent, from, owner },
    extra: { SelfLinkInvalid: () => OWNERR.selfLinkInvalid(sid), SelfDisabled: () => OWNERR.selfDisabled() },
    done: (tx) => deps.io.out(OWN.linked(tx)),
  });
}

// ---------------------------------------------------------------- release deprecate|revoke, revoke release (J4)

export async function releaseStatus(g: Global, deps: Deps, o: { id?: string | undefined; agent?: string | undefined; to: 'deprecate' | 'revoke' }): Promise<number> {
  if (!o.id || !BYTES32.test(o.id)) throw ERR.usage(`Usage: attessa ${o.to === 'revoke' ? 'revoke release' : 'release deprecate'} <releaseId> [--agent <id>]`);
  const rid = o.id.toLowerCase() as Hex;
  const c = await connect(g, deps);
  const approvals = await events(c, 'ReleaseApproved', { releaseId: rid });
  let agentId: bigint;
  if (o.agent !== undefined) agentId = needAgent(o.agent);
  else {
    const agents = [...new Set(approvals.map((a) => (a.args.agentId as bigint).toString()))];
    if (agents.length === 0) throw OWNERR.noSuchRelease(rid);
    if (agents.length > 1) throw OWNERR.ambiguousRelease(rid, agents);
    agentId = BigInt(agents[0]!);
  }
  const agent = agentId.toString();
  const rel = await read(c, c.registry, REGISTRY_ABI, 'releases', [agentId, rid]);
  const status = RELEASE_STATUS[rel.status as number];
  if (status === 'None') throw OWNERR.unknownRelease(agent, rid);
  const owner = await ownerOf(c, agentId);
  const from = sender(c, owner);
  if (from !== owner) throw ERR.notOwner(agent, owner, from);
  const src = sourceLabel((approvals.filter((a) => a.args.agentId === agentId).at(-1)?.args.sourceRef as string | undefined) ?? 'an unstated source');
  const step: Step = {
    label: 'setReleaseStatus',
    to: c.registry,
    data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'setReleaseStatus', args: [agentId, rid, o.to === 'revoke' ? 3 : 2] }),
  };
  let prompt: (cost: string) => string;
  if (o.to === 'revoke') {
    // Live signers of this build and the origins they serve (J4's "Its 1 live signer … risk.example refuses calls").
    const now = (await head(c)).timestamp;
    const live: Hex[] = [];
    for (const ev of await events(c, 'SignerRegistered', { agentId, releaseId: rid })) {
      const s = await read(c, c.registry, REGISTRY_ABI, 'signers', [ev.args.signer as Address]);
      if (SIGNER_STATUS[s.status as number] === 'Active' && (s.expiresAt as bigint) > now) live.push(s.originHash as Hex);
    }
    const hosts = [...new Set(await Promise.all([...new Set(live)].map(async (oh) => safe(host((await originOf(c, oh)) ?? short(oh))))))];
    prompt = () => OWN.revokeReleasePrompt(src, live.length, hosts);
  } else {
    prompt = () => OWN.deprecatePrompt(src);
  }
  return write(c, g, deps, {
    from,
    step,
    yesWord: o.to,
    prompt,
    rc: { agent, from, owner, releaseId: rid },
    extra: { InvalidTransition: () => OWNERR.invalidTransition(rid, status!.toLowerCase()) },
    done: (tx) => deps.io.out(o.to === 'revoke' ? OWN.revoked(tx) : OWN.deprecated(tx)),
  });
}

// ---------------------------------------------------------------- revoke signer

export async function revokeSigner(g: Global, deps: Deps, o: { signer?: string | undefined }): Promise<number> {
  if (!o.signer || !ADDRESS.test(o.signer)) throw ERR.usage('Usage: attessa revoke signer <address>');
  const signer = o.signer.toLowerCase() as Address;
  const c = await connect(g, deps);
  const s = await read(c, c.registry, REGISTRY_ABI, 'signers', [signer]);
  if (SIGNER_STATUS[s.status as number] === 'None') throw new CliError('unknown_signer', `No signer ${signer} is registered on this network.`, '`attessa status --agent <id>` lists an agent\'s signers.'); // FLOWS names the agent; a bare address has none
  const agentId = s.agentId as bigint;
  const agent = agentId.toString();
  if (SIGNER_STATUS[s.status as number] !== 'Active') throw OWNERR.signerNotActive(signer);
  const owner = await ownerOf(c, agentId);
  const from = sender(c, owner);
  if (from !== owner) throw ERR.notOwner(agent, owner, from);
  const origin = (await originOf(c, s.originHash as Hex)) ?? short(s.originHash as Hex);
  const step: Step = { label: 'revokeSigner', to: c.registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'revokeSigner', args: [getAddress(signer)] }) };
  return write(c, g, deps, {
    from,
    step,
    yesWord: 'revoke',
    prompt: () => OWN.revokeSignerPrompt(signer, host(origin), agent),
    rc: { agent, from, owner, signer },
    extra: { SignerNotActive: () => OWNERR.signerNotActive(signer) },
    done: (tx) => deps.io.out(OWN.revoked(tx)),
  });
}

// ---------------------------------------------------------------- endpoint retire

export async function endpointRetire(g: Global, deps: Deps, o: { origin?: string | undefined }): Promise<number> {
  if (!o.origin) throw ERR.usage('--origin is required, like https://risk.example.');
  let origin: string;
  try {
    origin = normalizeOrigin(o.origin, { local: g.network === 'local' });
  } catch {
    throw ERR.invalidOrigin();
  }
  const c = await connect(g, deps);
  const oh = originHash(origin);
  const e = await read(c, c.registry, REGISTRY_ABI, 'endpoints', [oh]);
  if (ENDPOINT_STATUS[e.status as number] !== 'Active') throw OWNERR.endpointNotActive(origin);
  const agentId = e.agentId as bigint;
  const agent = agentId.toString();
  const owner = await ownerOf(c, agentId);
  const from = sender(c, owner);
  if (from !== owner) throw ERR.notOwner(agent, owner, from);
  const step: Step = { label: 'retireEndpoint', to: c.registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'retireEndpoint', args: [oh] }) };
  return write(c, g, deps, {
    from,
    step,
    yesWord: 'retire',
    prompt: () => OWN.retirePrompt(host(origin), agent),
    rc: { agent, from, owner, origin },
    extra: { EndpointNotActive: () => OWNERR.endpointNotActive(origin) },
    done: (tx) => deps.io.out(OWN.retired(tx)),
  });
}

// ---------------------------------------------------------------- status --agent

export async function agentStatus(g: Global, deps: Deps, o: { agent?: string | undefined }): Promise<number> {
  const agentId = needAgent(o.agent);
  const agent = agentId.toString();
  const c = await connect(g, deps);
  const now = (await head(c)).timestamp;
  const out = deps.io.out;
  const releases: Array<{ releaseId: Hex; status: string; sourceRef: string }> = [];
  for (const ev of await events(c, 'ReleaseApproved', { agentId })) {
    const rid = ev.args.releaseId as Hex;
    if (releases.some((r) => r.releaseId === rid)) continue;
    const r = await read(c, c.registry, REGISTRY_ABI, 'releases', [agentId, rid]);
    releases.push({ releaseId: rid, status: RELEASE_STATUS[r.status as number]!, sourceRef: ev.args.sourceRef as string });
  }
  const endpoints: Array<{ origin: string; originHash: Hex; status: string; payTo: string; operator: string }> = [];
  for (const ev of await events(c, 'EndpointAdded', { agentId })) {
    const oh = ev.args.originHash as Hex;
    const e = await read(c, c.registry, REGISTRY_ABI, 'endpoints', [oh]);
    // An origin retired and re-added by another agent belongs to that agent now.
    if ((e.agentId as bigint) !== agentId || endpoints.some((x) => x.originHash === oh)) continue;
    endpoints.push({ origin: ev.args.origin as string, originHash: oh, status: ENDPOINT_STATUS[e.status as number]!, payTo: (e.payTo as string).toLowerCase(), operator: (e.operator as string).toLowerCase() });
  }
  const signers = [];
  for (const ev of await events(c, 'SignerRegistered', { agentId })) {
    const addr = (ev.args.signer as string).toLowerCase() as Address;
    const s = await read(c, c.registry, REGISTRY_ABI, 'signers', [addr]);
    const st = SIGNER_STATUS[s.status as number]!;
    signers.push({
      signer: addr,
      status: st === 'Active' && (s.expiresAt as bigint) <= now ? 'Expired' : st,
      releaseId: s.releaseId as Hex,
      originHash: s.originHash as Hex,
      expiresAt: (s.expiresAt as bigint).toString(),
      expiresAtIso: new Date(Number(s.expiresAt) * 1000).toISOString(),
    });
  }
  // FLOWS §8 places: heading "Agent {id}", empty "No releases yet. …", then the lists. The list lines are not in FLOWS.
  out(`Agent ${agent}`);
  if (releases.length === 0) out('No releases yet. Approve one with `attessa release approve`.');
  for (const r of releases) out(`  Release ${short(r.releaseId)}: ${r.status}, owner says ${sourceLabel(r.sourceRef)}`);
  for (const e of endpoints) out(`  Endpoint ${safe(e.origin)}: ${e.status}, pays ${e.payTo}, operator ${e.operator}`);
  for (const s of signers) out(`  Signer ${short(s.signer)}: ${s.status}, release ${short(s.releaseId)}, valid until ${utcShort(BigInt(s.expiresAt))}`);
  const active = signers.filter((s) => s.status === 'Active');
  deps.io.data?.({ agentId: agent, releases, endpoints, signers, signer: active.at(-1) ?? signers.at(-1) ?? null });
  return 0;
}

