import { normalizeOrigin, originHash, releaseId } from '@attessa/core';
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { ENDPOINT_STATUS, IDENTITY_ABI, REGISTRY_ABI, RELEASE_STATUS } from '../abi.ts';
import { connect, type Deps, type Global } from '../context.ts';
import { COPY, CliError, ERR, celo, host, sourceLabel } from '../copy.ts';
import { revertToError } from '../reverts.ts';
import { gasPrice, planOrSend, read, simulate, type Step } from '../tx.ts';

/** Owner commands: `release approve` and `endpoint add` (SPEC §8, FLOWS §6 J3). */

const DEC = /^(0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PCR = /^(0x)?[0-9a-fA-F]{96}$/;

export function parseAgent(v: string | undefined): bigint {
  if (!v || !DEC.test(v)) throw ERR.usage('--agent must be the agent id, a decimal number.');
  return BigInt(v);
}

/** `nitro-cli build-enclave` output: `{"Measurements":{"HashAlgorithm":…,"PCR0":"…","PCR1":"…","PCR2":"…"}}`. */
export function readMeasurements(deps: Deps, file: string): [Hex, Hex, Hex] {
  let json: unknown;
  try {
    json = JSON.parse(deps.readFile(file).toString('utf8'));
  } catch {
    throw ERR.invalidBuildFile(file);
  }
  const m = (json as { Measurements?: Record<string, unknown> } | null)?.Measurements;
  const pcrs = [m?.PCR0, m?.PCR1, m?.PCR2];
  if (!pcrs.every((p): p is string => typeof p === 'string' && PCR.test(p))) throw ERR.invalidBuildFile(file);
  const hex = pcrs.map((p) => `0x${p.replace(/^0x/, '').toLowerCase()}` as Hex) as [Hex, Hex, Hex];
  if (hex.some((p) => /^0x0+$/.test(p))) throw ERR.invalidBuildFile(file);
  return hex;
}

async function ownerOf(c: Awaited<ReturnType<typeof connect>>, agentId: bigint): Promise<Address> {
  const identity = (await read(c, c.registry, REGISTRY_ABI, 'identityRegistry', [])) as Address;
  try {
    return ((await read(c, identity, IDENTITY_ABI, 'ownerOf', [agentId])) as Address).toLowerCase() as Address;
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError('unknown_agent', `Agent ${agentId} doesn't exist on this network's identity registry.`, 'Check --agent and --network.');
  }
}

export async function releaseApprove(g: Global, deps: Deps, o: { agent?: string; fromBuild?: string; source?: string }): Promise<number> {
  const agentId = parseAgent(o.agent);
  if (!o.fromBuild) throw ERR.usage('--from-build <measurements.json> is required.');
  if (!o.source || Buffer.byteLength(o.source) < 1 || Buffer.byteLength(o.source) > 256) {
    throw ERR.usage('--source must be 1 to 256 bytes, like https://github.com/acme/risk/commit/a1b2c3d.');
  }
  const [pcr0, pcr1, pcr2] = readMeasurements(deps, o.fromBuild);
  const c = await connect(g, deps);
  const rid = releaseId(pcr0, pcr1, pcr2);
  const agent = agentId.toString();
  const owner = await ownerOf(c, agentId);
  const from = (c.account?.address.toLowerCase() as Address | undefined) ?? owner;
  if (from !== owner) throw ERR.notOwner(agent, owner, from);
  const rel = await read(c, c.registry, REGISTRY_ABI, 'releases', [agentId, rid]);
  if (RELEASE_STATUS[rel.status as number] !== 'None') throw ERR.releaseExists(agent, rid);

  const step: Step = {
    label: 'approveRelease',
    to: c.registry,
    data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'approveRelease', args: [agentId, pcr0, pcr1, pcr2, o.source] }),
  };
  const rc = { agent, from, owner, releaseId: rid };
  const sim = await simulate(c, from, step);
  if (!sim.ok) throw revertToError(sim.revert, sim.message, rc);
  const src = sourceLabel(o.source);
  deps.io.out(COPY.approveIntro(src, agent, rid));
  deps.io.out(COPY.approvePrompt(src, celo(sim.gas * (await gasPrice(c)))));
  const r = await planOrSend(c, g, deps, { yesWord: 'approve', steps: [step], from, simulations: [sim] }, (rv, m) => revertToError(rv, m, rc), (_i, s) =>
    deps.io.out(COPY.approved(s.hash)),
  );
  return r === 'cancelled' ? 1 : 0;
}

export async function endpointAdd(g: Global, deps: Deps, o: { agent?: string; origin?: string; payTo?: string; operator?: string }): Promise<number> {
  const agentId = parseAgent(o.agent);
  if (!o.origin) throw ERR.usage('--origin is required, like https://risk.example.');
  let origin: string;
  try {
    origin = normalizeOrigin(o.origin, { local: g.network === 'local' });
  } catch {
    throw ERR.invalidOrigin();
  }
  // What's registered is exactly what the buyer's SDK normalises to; anything else is refused, not rewritten.
  if (o.origin !== origin && o.origin !== `${origin}/`) throw ERR.invalidOrigin();
  if (!o.payTo || !ADDRESS.test(o.payTo)) throw ERR.usage('--pay-to must be an address.');
  if (o.operator !== undefined && !ADDRESS.test(o.operator)) throw ERR.usage('--operator must be an address.');
  const c = await connect(g, deps);
  const agent = agentId.toString();
  const owner = await ownerOf(c, agentId);
  const from = (c.account?.address.toLowerCase() as Address | undefined) ?? owner;
  if (from !== owner) throw ERR.notOwner(agent, owner, from);
  const oh = originHash(origin);
  const existing = await read(c, c.registry, REGISTRY_ABI, 'endpoints', [oh]);
  if (ENDPOINT_STATUS[existing.status as number] === 'Active') throw ERR.originTaken(origin, (existing.agentId as bigint).toString());
  // The operator registers signers from the EC2 host; by default the owner wallet running this command.
  const operator = getAddress(o.operator ?? from);
  const payTo = getAddress(o.payTo);
  const step: Step = {
    label: 'addEndpoint',
    to: c.registry,
    data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'addEndpoint', args: [agentId, origin, payTo, operator] }),
  };
  const rc = { agent, from, owner, origin };
  const sim = await simulate(c, from, step);
  if (!sim.ok) throw revertToError(sim.revert, sim.message, rc);
  deps.io.out(COPY.endpointPrompt(host(origin), payTo.toLowerCase(), agent, celo(sim.gas * (await gasPrice(c)))));
  if (!o.operator) deps.io.out(`  (operator ${operator.toLowerCase()}: the wallet that will run attessa signer register)`);
  const r = await planOrSend(c, g, deps, { yesWord: 'add', steps: [step], from, simulations: [sim] }, (rv, m) => revertToError(rv, m, rc), (_i, s) =>
    deps.io.out(COPY.endpointAdded(s.hash)),
  );
  return r === 'cancelled' ? 1 : 0;
}
