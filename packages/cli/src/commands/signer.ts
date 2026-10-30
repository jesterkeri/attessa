import { randomBytes } from 'node:crypto';
import {
  BINDING_TYPEHASH,
  eip712Domain,
  livenessDigest,
  livenessFromJson,
  normalizeOrigin,
  originHash as hashOrigin,
  recoverDigestSigner,
  releaseId as computeReleaseId,
  signerFromPublicKey,
} from '@attessa/core';
import { decodeAbiParameters, encodeFunctionData, parseAbiItem, size, toEventSelector, toHex, type Address, type Hex } from 'viem';
import { CERT_MANAGER_ABI, ENDPOINT_STATUS, REGISTRY_ABI, RELEASE_STATUS, SIGNER_STATUS, VALIDATOR_ABI } from '../abi.ts';
import { hintPlan, parseAttestation, type ParsedAttestation } from '../attestation.ts';
import { SELLER_HOST_URL, connect, type Chain, type Deps, type Global } from '../context.ts';
import { COPY, CliError, ERR, RENEW, celo, host, short, utcShort } from '../copy.ts';
import { revertToError, type RevertContext } from '../reverts.ts';
import { gasPrice, head, planOrSend, read, simulate, type Simulation, type Step } from '../tx.ts';
import { parseAgent } from './owner.ts';

/**
 * Operator commands `signer register` and `signer renew` (SPEC §3.4, §8; FLOWS §6 J3). Both cache only the
 * certificates CertManager doesn't already hold unexpired, then submit the attestation.
 */

const MAX_ATTESTATION_AGE = 1800n;
const MAX_FUTURE_SKEW = 60n;
/** ADR-010 r2 measurements: a same-day warm registration is 2 txs ≈ 20.8M gas, so ≈ 10.4M gas per tx. Used only
 *  to quote steps that can't be estimated before an earlier certificate lands. */
const GAS_PER_UNESTIMATED_TX = 10_400_000n;

export function sellerHostUrl(g: Global, flag: string | undefined): string {
  if (flag) return flag.replace(/\/$/, '');
  if (g.network === 'local') throw ERR.usage('--network local needs --seller-host <url>.');
  return SELLER_HOST_URL[g.network];
}

/** `POST /internal/attest` on the local seller-host: a fresh attestation for the running key (no restart). */
export async function fetchAttestation(deps: Deps, url: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await deps.fetch(`${url}/internal/attest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CliError('seller_host_unreachable', `Can't reach the seller-host at ${url}.`, 'Check `systemctl status attessa-seller@<network>` on this host.');
  }
  const json = (await res.json().catch(() => null)) as { attestation?: unknown; error?: unknown } | null;
  if (res.status !== 200 || typeof json?.attestation !== 'string') {
    if (json?.error === 'enclave_unavailable' || json?.error === 'not_configured') {
      throw new CliError('enclave_unavailable', `The seller-host at ${url} has no running, configured enclave (${String(json.error)}).`, 'Run `attessa enclave start` first.');
    }
    throw new CliError('seller_host_error', `The seller-host at ${url} answered HTTP ${res.status}.`, null);
  }
  return Buffer.from(json.attestation, 'base64');
}

interface Binding {
  typehash: Hex;
  chainId: bigint;
  registry: Address;
  agentId: bigint;
  originHash: Hex;
}

function decodeBinding(a: ParsedAttestation): Binding | null {
  if (!a.userData || size(a.userData) !== 160) return null;
  const [typehash, chainId, registry, agentId, originHash] = decodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
    a.userData,
  );
  return { typehash, chainId, registry: registry.toLowerCase() as Address, agentId, originHash };
}

/** The first `BindingMismatch` field (SPEC §3.4 step 6) for what the registry expects, or null when it binds. */
function bindingField(b: Binding | null, c: Chain, agentId: bigint, oh: Hex): number | null {
  if (!b) return 0;
  if (b.typehash !== BINDING_TYPEHASH) return 1;
  if (b.chainId !== BigInt(c.chainId)) return 2;
  if (b.registry !== c.registry) return 3;
  if (b.agentId !== agentId) return 4;
  if (b.originHash.toLowerCase() !== oh.toLowerCase()) return 5;
  return null;
}

function bindingWords(b: Binding | null): (field: number) => string {
  return (field) => {
    if (!b || field <= 1) return 'another protocol version (its binding has a different format)';
    if (field === 2) return `chain ${b.chainId}`;
    if (field === 3) return `registry ${short(b.registry)}`;
    if (field === 4) return `agent ${b.agentId}`;
    return `another origin (hash ${short(b.originHash)})`;
  };
}

const ENDPOINT_ADDED = parseAbiItem('event EndpointAdded(bytes32 indexed originHash, uint256 indexed agentId, string origin, address payTo, address operator)');

function normalizedOrigin(flag: string, local: boolean): string {
  try {
    return normalizeOrigin(flag, { local });
  } catch {
    throw ERR.invalidOrigin();
  }
}

/** The origin string for copy: `--origin`, else the `EndpointAdded` log for this hash, else the hash itself. */
async function originFor(c: Chain, oh: Hex, flag: string | undefined, local: boolean): Promise<string> {
  if (flag) return normalizedOrigin(flag, local);
  try {
    const logs = (await c.rpc.request('eth_getLogs', [
      { address: c.registry, fromBlock: '0x0', toBlock: 'latest', topics: [toEventSelector(ENDPOINT_ADDED), oh] },
    ])) as Array<{ data: Hex }>;
    const last = logs.at(-1);
    if (last) {
      const [o] = decodeAbiParameters([{ type: 'string' }, { type: 'address' }, { type: 'address' }], last.data);
      if (hashOrigin(o) === oh) return o;
    }
  } catch {
    // Some RPCs cap log ranges; fall back to the hash.
  }
  return short(oh);
}


interface CertPlan {
  steps: Step[];
  simulations: Array<Simulation | null>;
  cached: number;
  total: number;
}

/** Steps that cache the certificates CertManager lacks, in chain order. Expired certificates can't be used. */
async function certSteps(c: Chain, a: ParsedAttestation, from: Address, now: bigint, E: typeof ERR | typeof RENEW = ERR): Promise<CertPlan & { plan: ReturnType<typeof hintPlan> }> {
  const plan = hintPlan(a);
  const validator = ((await read(c, c.registry, REGISTRY_ABI, 'nitroValidator', [])) as Address).toLowerCase() as Address;
  const cm = ((await read(c, validator, VALIDATOR_ABI, 'certManager', [])) as Address).toLowerCase() as Address;
  const steps: Step[] = [];
  const simulations: Array<Simulation | null> = [];
  let cached = 0;
  let parentReady = true;
  for (const cert of plan.certs) {
    if (cert.notAfter <= now) throw E.certExpired();
    const v = await read(c, cm, CERT_MANAGER_ABI, 'loadVerified', [cert.certHash]);
    if (v.pubKey !== '0x') {
      if ((v.notAfter as bigint) <= now) throw E.certExpired();
      cached++;
      continue;
    }
    const step: Step =
      cert.kind === 'ca'
        ? {
            label: `cache CA certificate ${cert.index}`,
            to: cm,
            data: encodeFunctionData({ abi: CERT_MANAGER_ABI, functionName: 'verifyCACertWithHints', args: [cert.cert, cert.parentCertHash, cert.hints] }),
          }
        : {
            label: 'cache leaf certificate',
            to: cm,
            data: encodeFunctionData({ abi: CERT_MANAGER_ABI, functionName: 'verifyClientCertWithHints', args: [cert.cert, cert.parentCertHash, cert.hints] }),
          };
    steps.push(step);
    // Only the first missing certificate can be simulated now: the next one needs its parent cached.
    simulations.push(parentReady ? await simulate(c, from, step) : null);
    parentReady = false;
  }
  return { plan, steps, simulations, cached, total: plan.certs.length };
}

function quote(sims: Array<Simulation | null>): bigint {
  return sims.reduce((sum, s) => sum + (s && s.ok ? s.gas : GAS_PER_UNESTIMATED_TX), 0n);
}

interface AttestationChecks {
  a: ParsedAttestation;
  rid: Hex;
  signer: Address;
  ageMinutes: number;
  binding: Binding | null;
}

/** SPEC §3.4 steps 3, 4, 5 and 7, off chain, against the chain's clock. `renew` words refusals for `signer renew`. */
async function checkAttestation(c: Chain, a: ParsedAttestation, agentId: bigint, now: bigint, renew = false): Promise<AttestationChecks> {
  const not = renew ? 'Not renewed' : 'Not registered';
  const ts = a.timestampMs / 1000n;
  if (ts > now + MAX_FUTURE_SKEW) {
    throw (renew ? RENEW : ERR).attestationFromFuture();
  }
  const age = ts > now ? 0n : now - ts;
  const ageMinutes = Number((age + 59n) / 60n);
  if (age > MAX_ATTESTATION_AGE) {
    throw renew ? ERR.renewRefused('attestation_stale', `the machine's report is ${ageMinutes} minutes old and Celo accepts 30`, false) : ERR.attestationStale(ageMinutes);
  }
  const pcrs = [0, 1, 2].map((i) => a.pcrs.get(i));
  if (!pcrs.every((p): p is Hex => !!p && size(p) === 48)) throw new CliError('invalid_pcr', `${not}: the report has no PCR0-2.`);
  if (pcrs.some((p) => /^0x0+$/.test(p))) throw renew ? RENEW.debugMode() : ERR.debugMode();
  const rid = computeReleaseId(pcrs[0]!, pcrs[1]!, pcrs[2]!);
  const rel = await read(c, c.registry, REGISTRY_ABI, 'releases', [agentId, rid]);
  if (RELEASE_STATUS[rel.status as number] !== 'Approved') throw (renew ? RENEW : ERR).wrongBuild(agentId.toString(), rid);
  if (!hasEnclaveKey(a)) throw noEnclaveKey(not);
  return { a, rid, signer: signerFromPublicKey(a.publicKey!), ageMinutes, binding: decodeBinding(a) };
}

/** SPEC §2.4: a 65-byte uncompressed key, `0x04 ‖ X ‖ Y`. */
function hasEnclaveKey(a: ParsedAttestation): boolean {
  return !!a.publicKey && size(a.publicKey) === 65 && a.publicKey.startsWith('0x04');
}

function noEnclaveKey(not: string): CliError {
  return new CliError('invalid_public_key', `${not}: the report carries no enclave key.`, 'Start the approved build with `attessa enclave start`.');
}

async function checkEndpoint(c: Chain, oh: Hex, agentId: bigint, origin: string, E: typeof ERR | typeof RENEW = ERR): Promise<{ operator: Address }> {
  const e = await read(c, c.registry, REGISTRY_ABI, 'endpoints', [oh]);
  if (ENDPOINT_STATUS[e.status as number] !== 'Active' || (e.agentId as bigint) !== agentId) throw E.endpointInactive(origin, agentId.toString());
  return { operator: (e.operator as string).toLowerCase() as Address };
}

/** Liveness smoke check through seller-host (FLOWS J3 step 7). Returns false when it can't be confirmed. */
async function livenessOk(c: Chain, deps: Deps, url: string, signer: Address, oh: Hex): Promise<boolean> {
  const challenge = toHex(randomBytes(32));
  try {
    const res = await deps.fetch(`${url}/internal/liveness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge }),
      signal: AbortSignal.timeout(5_000),
    });
    const j = (await res.json()) as { liveness: unknown; signature: string };
    const l = livenessFromJson(j.liveness);
    if (l.challenge !== challenge || l.originHash !== oh) return false;
    return (await recoverDigestSigner(livenessDigest(eip712Domain(BigInt(c.chainId), c.registry), l), j.signature)) === signer;
  } catch {
    return false;
  }
}

export interface RegisterOptions {
  agent?: string;
  attestation?: string;
  fresh?: boolean;
  origin?: string;
  sellerHost?: string;
}

export async function signerRegister(g: Global, deps: Deps, o: RegisterOptions): Promise<number> {
  const agentId = parseAgent(o.agent);
  if (!!o.attestation === !!o.fresh) throw ERR.usage('Pass exactly one of --attestation <file> or --fresh.');
  const url = o.fresh || !o.attestation ? sellerHostUrl(g, o.sellerHost) : null;
  const raw = o.attestation ? deps.readFile(o.attestation) : await fetchAttestation(deps, url!);
  const a = parseAttestation(raw);
  const c = await connect(g, deps);
  const agent = agentId.toString();
  const now = (await head(c)).timestamp;
  const binding = decodeBinding(a);
  // Which endpoint: --origin, else the one the enclave bound into user_data.
  const oh = o.origin ? hashOrigin(normalizedOrigin(o.origin, g.network === 'local')) : binding?.originHash;
  if (!oh) throw ERR.bindingMismatch(bindingWords(null)(0), '0');
  const origin = await originFor(c, oh, o.origin, g.network === 'local');

  const { operator } = await checkEndpoint(c, oh, agentId, origin);
  const from = (c.account?.address.toLowerCase() as Address | undefined) ?? operator;
  if (from !== operator) throw ERR.notOperator(from, origin);
  const chk = await checkAttestation(c, a, agentId, now);
  const field = bindingField(binding, c, agentId, oh);
  if (field !== null) throw ERR.bindingMismatch(bindingWords(binding)(field), String(field));
  const existing = await read(c, c.registry, REGISTRY_ABI, 'signers', [chk.signer]);
  if (SIGNER_STATUS[existing.status as number] !== 'None') throw ERR.signerExists(chk.signer);

  const certs = await certSteps(c, a, from, now);
  const register: Step = {
    label: 'registerSigner',
    to: c.registry,
    data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'registerSigner', args: [agentId, oh, toHex(a.raw), certs.plan.attestationHints] }),
  };
  const rc: RevertContext = { agent, from, origin, releaseId: chk.rid, signer: chk.signer, ageMinutes: chk.ageMinutes, bindingWords: bindingWords(binding) };
  const regSim = certs.steps.length === 0 ? await simulate(c, from, register) : null;
  if (regSim && !regSim.ok) throw revertToError(regSim.revert, regSim.message, rc);
  for (const s of certs.simulations) if (s && !s.ok) throw revertToError(s.revert, s.message, rc);

  const steps = [...certs.steps, register];
  const sims = [...certs.simulations, regSim];
  const price = await gasPrice(c);
  const maxTxs = certs.total + 1;
  deps.io.out(COPY.registerPrompt(certs.cached, certs.total, steps.length, celo(quote(sims) * price), celo(BigInt(maxTxs) * GAS_PER_UNESTIMATED_TX * price)));
  const r = await planOrSend(c, g, deps, { yesWord: 'register', steps, from, simulations: sims }, (rv, m) => revertToError(rv, m, rc), async (i, sent) => {
    if (i < steps.length - 1) return deps.io.out(COPY.certCached(i + 1, steps.length, sent.hash));
    deps.io.out(COPY.signerLive(i + 1, steps.length, chk.signer, host(origin), agent, sent.hash));
    const s = await read(c, c.registry, REGISTRY_ABI, 'signers', [chk.signer]);
    deps.io.out(COPY.validUntil(utcShort(s.expiresAt as bigint)));
    const lurl = url ?? (g.network === 'local' ? null : SELLER_HOST_URL[g.network]);
    if (lurl && (await livenessOk(c, deps, lurl, chk.signer, oh))) deps.io.out(COPY.livenessOk);
    else deps.io.out(`  (liveness not confirmed from this machine; check it with attessa status ${host(origin)})`);
  });
  return r === 'cancelled' ? 1 : 0;
}

export async function signerRenew(g: Global, deps: Deps, o: { attestation?: string; sellerHost?: string }): Promise<number> {
  const raw = o.attestation ? deps.readFile(o.attestation) : await fetchAttestation(deps, sellerHostUrl(g, o.sellerHost));
  const a = parseAttestation(raw);
  // The signer is looked up by the report's key, so its form is checked before anything else.
  if (!hasEnclaveKey(a)) throw noEnclaveKey('Not renewed');
  const signer = signerFromPublicKey(a.publicKey!);
  const c = await connect(g, deps);
  const now = (await head(c)).timestamp;
  const s = await read(c, c.registry, REGISTRY_ABI, 'signers', [signer]);
  const status = SIGNER_STATUS[s.status as number];
  if (status === 'None') {
    throw new CliError('signer_not_active', `Not renewed: signer ${short(signer)} was never registered.`, 'Register it with `attessa signer register --fresh`.');
  }
  if (status === 'Revoked') throw ERR.renewRefused('signer_not_active', 'the owner revoked this signer', true);
  if (now >= (s.expiresAt as bigint)) throw ERR.renewRefused('signer_not_active', 'the signer already expired', true);
  const agentId = s.agentId as bigint;
  const agent = agentId.toString();
  const oh = (s.originHash as string).toLowerCase() as Hex;
  const origin = await originFor(c, oh, undefined, g.network === 'local');
  const { operator } = await checkEndpoint(c, oh, agentId, origin, RENEW);
  const from = (c.account?.address.toLowerCase() as Address | undefined) ?? operator;
  if (from !== operator || operator !== (s.operator as string).toLowerCase()) throw RENEW.notOperator(from, origin);
  // renewSigner repeats registerSigner steps 2-7 (SPEC §3.4), so the same checks run before any certificate is cached.
  const { rid, ageMinutes, binding } = await checkAttestation(c, a, agentId, now, true);
  const field = bindingField(binding, c, agentId, oh);
  if (field !== null) throw RENEW.bindingMismatch(bindingWords(binding)(field), String(field));
  if (rid !== (s.releaseId as string).toLowerCase()) throw ERR.renewRefused('release_mismatch', 'this report is from a different build', false);

  const certs = await certSteps(c, a, from, now, RENEW);
  const renew: Step = {
    label: 'renewSigner',
    to: c.registry,
    data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'renewSigner', args: [signer, toHex(a.raw), certs.plan.attestationHints] }),
  };
  const rc: RevertContext = { agent, from, origin, releaseId: rid, signer, ageMinutes, bindingWords: bindingWords(binding), renewing: true };
  const renewSim = certs.steps.length === 0 ? await simulate(c, from, renew) : null;
  if (renewSim && !renewSim.ok) throw revertToError(renewSim.revert, renewSim.message, rc);
  for (const sim of certs.simulations) if (sim && !sim.ok) throw revertToError(sim.revert, sim.message, rc);
  const steps = [...certs.steps, renew];
  const sims = [...certs.simulations, renewSim];
  deps.io.out(COPY.renewPrompt(signer, certs.cached, certs.total, steps.length, celo(quote(sims) * (await gasPrice(c)))));
  const r = await planOrSend(c, g, deps, { yesWord: 'renew', steps, from, simulations: sims }, (rv, m) => revertToError(rv, m, rc), async (i, sent) => {
    if (i < steps.length - 1) return deps.io.out(COPY.certCached(i + 1, steps.length, sent.hash));
    const after = await read(c, c.registry, REGISTRY_ABI, 'signers', [signer]);
    deps.io.out(COPY.renewed(i + 1, steps.length, signer, utcShort(after.expiresAt as bigint), sent.hash));
  });
  return r === 'cancelled' ? 1 : 0;
}
