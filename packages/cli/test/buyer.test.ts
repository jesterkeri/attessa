import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originHash } from '@attessa/core';
import type { Keychain } from '@attessa/sdk';
import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain, RpcFailure } from '../../sdk/test/fakes/chain.ts';
import { FakeGateway } from '../../sdk/test/fakes/gateway.ts';
import type { Deps } from '../src/context.ts';
import { run } from '../src/index.ts';
import { expectFlows, flowsBlock, flowsOutput } from './flows.ts';

// Buyer journeys (FLOWS §6 J0, J1, J2, J2 variant, J1 interrupted) through the real CLI and SDK, against the
// SDK's in-process fake chain and x402 gateway. No network, no real keys: every key is generated in-test.

const AGENT = 412n;
const SOURCE = 'https://github.com/acme/risk/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

class MemKeychain implements Keychain {
  store = new Map<string, string>();
  async getPassword(s: string, a: string) {
    return this.store.get(`${s}/${a}`) ?? null;
  }
  async setPassword(s: string, a: string, p: string) {
    this.store.set(`${s}/${a}`, p);
  }
}

async function buyerWorld() {
  const chain = new FakeChain({ startTime: 1_793_000_000n, startBlock: 31_204_000n });
  const rnd = () => privateKeyToAccount(generatePrivateKey());
  const operator = rnd().address.toLowerCase() as Address;
  const payTo = rnd().address.toLowerCase() as Address;
  const enclave = rnd();
  const releaseId = keccak256(stringToBytes(`release-${Math.random()}`));
  chain.approveRelease(AGENT, releaseId, SOURCE);
  const gw = new FakeGateway(chain, { agentId: AGENT, releaseId, payTo, enclave });
  const origin = await gw.start();
  gw.originHash = originHash(origin);
  chain.addEndpoint(AGENT, origin, gw.originHash, payTo, operator);
  chain.registerSigner(enclave.address, AGENT, releaseId, gw.originHash, operator);
  chain.setAccount(payTo, { code: '0x', nonce: 3n, balance: 10n ** 18n });
  chain.advance(5);

  const home = mkdtempSync(join(tmpdir(), 'attessa-cli-'));
  const keychain = new MemKeychain();
  const w = {
    chain,
    gw,
    origin,
    url: `${origin}/v1/evaluate`,
    host: origin.replace(/^https?:\/\//, ''),
    home,
    keychain,
    enclave,
    payTo,
    /** stdout and stderr in the order printed. */
    transcript: [] as string[],
    out: [] as string[],
    err: [] as string[],
    confirmAnswer: true,
    env: { ATTESSA_REGISTRY: chain.registry } as Record<string, string | undefined>,
    deps(): Deps {
      return {
        io: {
          out: (l) => void (w.out.push(l), w.transcript.push(l)),
          err: (l) => void (w.err.push(l), w.transcript.push(l)),
          confirm: async () => w.confirmAnswer,
        },
        env: w.env,
        cwd: home,
        home,
        keychain,
        rpc: () => {
          throw new Error('buyer commands use the SDK transport');
        },
        runner: { run: async () => ({ code: 1, stdout: '', stderr: 'no runner in buyer tests' }) },
        fetch,
        enclave: () => {
          throw new Error('no enclave in buyer tests');
        },
        readFile: (p) => readFileSync(p),
        writeFile: (p, d) => writeFileSync(p, d),
        exists: (p) => existsSync(p),
        readdir: (p) => readdirSync(p),
        sleep: async () => {},
        arch: 'x64',
        sdk: {
          transport: chain.transport(),
          sleep: async (ms: number) => chain.advance(Math.max(1, ms / 1000)),
          receiptWaitMs: 2000,
          httpTimeoutMs: 5000,
        },
      };
    },
    cli(...argv: string[]) {
      return run(argv, w.deps());
    },
    /** `attessa call` on the fake chain (`--network local`). */
    call(...extra: string[]) {
      return run(['call', w.url, '--body', 'tx.json', '--network', 'local', '--rpc', 'http://127.0.0.1:1', ...extra], w.deps());
    },
    evidence(): Array<Record<string, unknown>> {
      const p = join(home, '.attessa', 'evidence.jsonl');
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    },
    pending(): Array<Record<string, unknown>> {
      const p = join(home, '.attessa', 'pending.jsonl');
      return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    async close() {
      await gw.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, 'tx.json'), JSON.stringify({ chainId: String(chain.chainId), payTo, asset: chain.asset, amount: '20000' }));
  return w;
}

type W = Awaited<ReturnType<typeof buyerWorld>>;
let w: W;
afterEach(async () => w?.close());

/** `attessa init` (J0), then a clean transcript. */
async function initialized(): Promise<W> {
  w = await buyerWorld();
  expect(await w.cli('init')).toBe(0);
  w.transcript.length = 0;
  w.out.length = 0;
  return w;
}

const J1 = flowsBlock('### J1 happy path');
const HOSTS = () => ({ [w.host]: 'risk.example' });

describe('buyer: attessa init (FLOWS §6 J0)', () => {
  it('first run: creates a keychain wallet and prints the J0 lines verbatim', async () => {
    w = await buyerWorld();
    expect(await w.cli('init')).toBe(0);
    expectFlows(w.transcript, flowsOutput(flowsBlock('### J0 first run'), 'attessa init'));
    const key = w.keychain.store.get('attessa/default')!;
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    const address = privateKeyToAccount(key as Hex).address.toLowerCase();
    expect(w.transcript.join('\n')).toContain(address);
    expect(w.transcript.join('\n')).not.toContain(key.slice(2));
    const cfg = JSON.parse(readFileSync(join(w.home, '.attessa', 'config.json'), 'utf8'));
    expect(cfg).toEqual({
      network: 'sepolia',
      limits: { usdc: { maxAmountPerCall: '0.10', dailyCap: '1.00' }, usat: { maxAmountPerCall: '0.10', dailyCap: '1.00' } },
    });
  });

  it('an existing ATTESSA_PRIVATE_KEY is used instead of creating one; nothing goes to the keychain', async () => {
    w = await buyerWorld();
    const key = generatePrivateKey();
    w.env.ATTESSA_PRIVATE_KEY = key;
    expect(await w.cli('init', '--max-amount', '0.05', '--daily-cap', '2')).toBe(0);
    expect(w.keychain.store.size).toBe(0);
    expect(w.out[2]).toBe(`Wallet: ${privateKeyToAccount(key).address.toLowerCase()} (key from ATTESSA_PRIVATE_KEY, never printed)`);
    expect(w.out[4]).toBe('Spending limits: at most 0.05 USDC per call and 2.00 USDC per day, unless you pass --max-amount / set --daily-cap.');
    expect(w.transcript.join('\n')).not.toContain(key.slice(2));
  });

  it('--network mainnet is remembered as the default for later commands', async () => {
    w = await buyerWorld();
    expect(await w.cli('init', '--network', 'mainnet')).toBe(0);
    expect(w.out[1]).toBe('Network: Celo mainnet (real money).');
    expect(JSON.parse(readFileSync(join(w.home, '.attessa', 'config.json'), 'utf8')).network).toBe('mainnet');
  });

  it('no keychain and no key: says so, creates nothing', async () => {
    w = await buyerWorld();
    const d = w.deps();
    expect(await run(['init'], { ...d, keychain: null })).toBe(1);
    expect(w.err).toEqual([
      'No OS keychain is available, so no wallet was created.',
      'Set ATTESSA_PRIVATE_KEY or pass --keystore <file> (password in ATTESSA_KEYSTORE_PASSWORD).',
    ]);
  });

  // SPEC §7 "Never printed": a --keystore file that isn't a keystore may hold a bare key, so the line names only
  // the path and a fixed reason, never the parser's message (which quotes the file).
  it('--keystore with a file that is not a keystore: a fixed line naming the path, nothing of the file', async () => {
    w = await buyerWorld();
    const key = generatePrivateKey();
    writeFileSync(join(w.home, 'key.txt'), `${key.slice(2)}\n`);
    w.env.ATTESSA_KEYSTORE_PASSWORD = 'pw';
    expect(await w.cli('init', '--keystore', 'key.txt')).toBe(1);
    expect(w.err[0]).toBe("Can't load the wallet from key.txt: not a V3 keystore.");
    expect(w.transcript.join('\n')).not.toMatch(new RegExp(key.slice(2, 8), 'i'));
    expect(w.keychain.store.size).toBe(0);
  });
});

describe('buyer: attessa call, verified (FLOWS §6 J1)', () => {
  it('happy path: the J1 lines verbatim, the answer in result.json, one settlement, one evidence row', async () => {
    await initialized();
    expect(await w.call()).toBe(0);
    expectFlows(w.transcript, flowsOutput(J1, 'attessa call'), { hosts: HOSTS(), slots: [['0.4 s', '\\d+\\.\\d s'], ['31,204,118', '[\\d,]+']] });
    expect(w.transcript[0]).toBe('Checking risk.example before paying'.replace('risk.example', w.host));
    expect(readFileSync(join(w.home, 'result.json'), 'utf8')).toContain('"verdict":"allow"');
    expect(w.gw.paid).toHaveLength(1);
    const ev = w.evidence();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ outcome: 'verified', agentId: '412', amount: '20000' });
    // "using Celo data from block N" is the inputs block the evidence records.
    expect(w.transcript.join('\n')).toContain(`using Celo data from block ${BigInt(ev[0]!.inputsBlock as string).toLocaleString('en-US')}  (settled: tx `);
  });

  it('price above the limit: the J1 refusal line, nothing signed', async () => {
    await initialized();
    w.gw.price = '250000';
    expect(await w.call()).toBe(1);
    expectFlows(w.transcript, flowsOutput(flowsBlock('Price above the limit:')));
    expect(w.gw.paid).toHaveLength(0);
    expect(w.pending()).toEqual([]);
  });

  it('--max-amount raises the per-call limit for this call (J1: "Pass --max-amount 0.25 if that\'s fine")', async () => {
    await initialized();
    w.gw.price = '250000';
    expect(await w.call('--max-amount', '0.25')).toBe(0);
    expect(w.transcript).toContain('Price: 0.25 USDC (your limit per call: 0.25), paid to the address registered for this service.');
  });

  it('--dry-run stops before signing', async () => {
    await initialized();
    expect(await w.call('--dry-run')).toBe(0);
    expect(w.transcript.at(-1)).toBe('  (dry run: nothing was signed)');
    expect(w.gw.paid).toHaveLength(0);
    expect(w.pending()).toEqual([]);
  });

  it('--json: one JSON object with the outcome and the settlement tx (T22)', async () => {
    await initialized();
    expect(await w.call('--json')).toBe(0);
    expect(w.out).toHaveLength(1);
    const j = JSON.parse(w.out[0]!);
    expect(j).toMatchObject({ ok: true, outcome: 'verified', amount: '20000', inputsChecked: true });
    expect(j.settlementTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(j.lines[0]).toBe(`Checking ${w.host} before paying`);
  });
});

describe('buyer: attessa call, refused (FLOWS §6 J2, J2 variant)', () => {
  it('J2 tampered response: refused by the gateway, waits for expiry, then "Not charged" from the chain', async () => {
    await initialized();
    w.gw.behavior = { paid: 'refuse' };
    expect(await w.call()).toBe(1);
    expectFlows(w.transcript, flowsBlock('### J2 tampered response').map((l) => (l.startsWith('→ ') ? l.slice(2) : l)), {
      hosts: HOSTS(),
      // J2's first line abbreviates J1's two price lines ("Price: 0.02 USDC … You sign a payment permission now (free).").
      slots: [['(free).', '\\(free\\)\\.[^\\n]*'], ['14:02:11', '\\d\\d:\\d\\d:\\d\\d'], ['94', '\\d+'], ['31,204,245', '[\\d,]+']],
    });
    const id = w.pending()[0]!.requestId as string;
    // The cancel hint names the full request id, so it can be run as printed.
    expect(w.transcript).toContain(`  To void it right now instead: attessa cancel ${id}  (on-chain cancel, ~0.0004 CELO gas). Ctrl-C stops waiting; attessa status --pending checks later.`);
    expect(w.pending()[0]!.state).toBe('not_charged');
  });

  it('J2 variant: charged but the answer failed V10 (paid_but_rejected): the warning lines verbatim', async () => {
    await initialized();
    w.gw.behavior = { tamperResponse: (b) => new TextEncoder().encode(new TextDecoder().decode(b).replace('allow', 'deny_')) };
    expect(await w.call()).toBe(1);
    expectFlows(w.transcript, flowsOutput(flowsBlock('### J2 variant')));
    expect(existsSync(join(w.home, 'result.json'))).toBe(false);
    expect(w.evidence().at(-1)).toMatchObject({ outcome: 'paid_but_rejected', check: 'response_hash_mismatch' });
  });

  it('J2 variant: refused, but the payment permission was used anyway (settled_after_refusal)', async () => {
    await initialized();
    w.gw.behavior = { paid: 'refuse_but_settle', refuseWith: { status: 504, error: 'execution_timeout' } };
    expect(await w.call()).toBe(1);
    expect(w.transcript).toContain("The service didn't respond in 20 s. Your payment permission wasn't used.");
    expectFlows(w.transcript, flowsOutput(flowsBlock('Refused, but the money moved anyway')));
    expect(w.evidence().at(-1)).toMatchObject({ outcome: 'settled_after_refusal' });
  });
});

describe('buyer: attessa call, interrupted (FLOWS §6 J1 interrupted)', () => {
  const block = (n: number) => flowsOutput(flowsBlock('### J1 interrupted', n));

  it('a proxy error page after signing, never settled: "Lost the connection…", then not charged at validBefore', async () => {
    await initialized();
    w.gw.behavior = { paid: 'html502' };
    expect(await w.call()).toBe(1);
    expectFlows(w.transcript, block(0), { slots: [['14:02:11', '\\d\\d:\\d\\d:\\d\\d']] });
    const e = w.pending()[0]!;
    expect(w.transcript.at(-1)).toBe(`Not charged: confirmed on Celo, your payment permission expired unused at ${new Date(Number(e.validBefore) * 1000).toISOString().slice(11, 19)} UTC.`);
  });

  it('the connection drops after settlement: charged, the answer fetched and checked', async () => {
    await initialized();
    w.gw.behavior = { paid: 'drop_after_settle' };
    expect(await w.call()).toBe(0);
    expectFlows(w.transcript, [block(0)[0]!, ...block(1)]);
    expect(readFileSync(join(w.home, 'result.json'), 'utf8')).toContain('"verdict":"allow"');
  });

  it('HTTP 202 settle_pending: "Payment sent, confirming…" with the tx, then the J1 paid line', async () => {
    await initialized();
    w.gw.behavior = { paid: 'pending', pendingTx: true };
    expect(await w.call()).toBe(0);
    expectFlows(w.transcript, block(2), { hosts: HOSTS(), slots: [['14:03:11', '\\d\\d:\\d\\d:\\d\\d']] });
    const vb = BigInt(w.pending()[0]!.validBefore as string);
    expect(w.transcript.join('\n')).toContain(`checking until ${new Date(Number(vb + 60n) * 1000).toISOString().slice(11, 19)} UTC)`);
  });

  it('re-running the same input while a call is open resumes it and never pays twice', async () => {
    await initialized();
    w.gw.behavior = { paid: 'pending_no_settle' };
    expect(await w.call('--no-wait')).toBe(1);
    const id = w.pending()[0]!.requestId as string;
    expect(w.transcript.at(-1)).toContain(`attessa cancel ${id} voids it now.`);
    w.transcript.length = 0;
    expect(await w.call()).toBe(1);
    expectFlows(w.transcript, block(3));
    expect(w.transcript).toContain(`You already have a call in progress for this input (request ${id}). Resuming it instead of paying again.`);
    expect(w.gw.paid).toHaveLength(1);
  });
});

describe('buyer: FLOWS §8 refusals before signing', () => {
  it('no per-call limit (no init, no --max-amount): max_amount_required, nothing signed', async () => {
    w = await buyerWorld();
    w.env.ATTESSA_PRIVATE_KEY = generatePrivateKey();
    expect(await w.call()).toBe(1);
    expect(w.err).toEqual(['No per-call limit is set, so nothing was signed.', 'Run `attessa init` or pass --max-amount in USDC (for example --max-amount 0.05).']);
  });

  it('no wallet: no_wallet', async () => {
    w = await buyerWorld();
    expect(await w.call('--max-amount', '0.05')).toBe(1);
    expect(w.err).toEqual(['No wallet set up yet.', 'Run `attessa init`.']);
  });

  it('payTo mismatch: possible impostor, both addresses named', async () => {
    await initialized();
    const evil = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    w.gw.behavior = { quote: (pr) => ((pr.accepts as Array<Record<string, unknown>>)[0]!.payTo = evil) };
    expect(await w.call()).toBe(1);
    expect(w.err).toEqual([
      `Not paying: this service asked to be paid at ${evil}, but its registered payment address is ${w.payTo}. It may be an impostor.`,
      "Don't retry. Report it to where you found the link (for buy: github.com/celo-org/buy-skill/issues).",
    ]);
    expect(w.gw.paid).toHaveLength(0);
  });

  it('over the daily cap: names today\'s spend and the cap', async () => {
    w = await buyerWorld();
    expect(await w.cli('init', '--daily-cap', '0.03')).toBe(0);
    expect(await w.call()).toBe(0);
    w.err.length = 0;
    expect(await w.call('--new')).toBe(1);
    expect(w.err).toEqual(["Not paying: this would take today's spend to 0.04 USDC; your cap is 0.03.", 'Wait until 00:00 UTC or raise `--daily-cap`.']);
  });

  it('call has no --daily-cap: one call cannot lift the saved cap (adversary t21 r1)', async () => {
    w = await buyerWorld();
    expect(await w.cli('init', '--daily-cap', '0.03')).toBe(0);
    expect(await w.call()).toBe(0);
    w.err.length = 0;
    expect(await w.call('--daily-cap', '100', '--new')).not.toBe(0);
    expect(w.gw.paid).toHaveLength(1);
    w.err.length = 0;
    expect(await w.call('--new')).toBe(1);
    expect(w.err).toEqual(["Not paying: this would take today's spend to 0.04 USDC; your cap is 0.03.", 'Wait until 00:00 UTC or raise `--daily-cap`.']);
  });

  it('liveness failed: the FLOWS line and next action', async () => {
    await initialized();
    w.gw.behavior = { liveness: () => ({ liveness: { nope: true }, signature: '0x' }) };
    expect(await w.call()).toBe(1);
    expect(w.err).toEqual([
      `Not paying: the sealed machine for ${w.origin} didn't answer a fresh check, so it may be down or this may not be the real address  (liveness).`,
      `\`attessa status ${w.origin}\` shows when it last answered.`,
    ]);
  });

  it('a retired endpoint: endpoint_retired, with the agent to look up', async () => {
    await initialized();
    w.chain.retireEndpoint(w.gw.originHash);
    expect(await w.call()).toBe(1);
    expect(w.err[0]).toBe(`${w.origin} has stopped selling (its owner retired it). Nothing was signed.`);
    expect(w.err[1]).toBe('`attessa status --agent 412` lists its current endpoints.');
  });

  it('the gateway is paused: gateway_paused, nothing signed', async () => {
    await initialized();
    w.gw.behavior = {
      unpaid: (res, requestId) => {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'gateway_paused', detail: null, message: 'paused', suggestion: 'retry_later', correlationId: 'c', requestId }));
        return true;
      },
    };
    expect(await w.call()).toBe(1);
    expect(w.err).toEqual(["The service can't take payments right now. Nothing was signed.", `\`attessa status ${w.origin}\`.`]);
  });
});

describe('buyer: cancel, status, evidence export', () => {
  it('attessa cancel voids a refused call at once: not_charged, recorded', async () => {
    await initialized();
    w.gw.behavior = { paid: 'refuse' };
    expect(await w.call('--no-wait')).toBe(1);
    const id = w.pending()[0]!.requestId as string;
    w.transcript.length = 0;
    expect(await w.cli('cancel', id, '--network', 'local', '--rpc', 'http://127.0.0.1:1', '--yes')).toBe(0);
    expect(w.transcript[0]).toMatch(/^Cancelled \(tx 0x[0-9a-f]{4}…[0-9a-f]{2}\)\.$/);
    expect(w.pending()[0]).toMatchObject({ state: 'not_charged', code: 'cancelled' });
  });

  it('attessa cancel from a wallet without CELO for gas: insufficient_gas_funds, "Nothing was sent.", the call stays open', async () => {
    await initialized();
    w.gw.behavior = { paid: 'refuse' };
    expect(await w.call('--no-wait')).toBe(1);
    const { requestId: id, payer } = w.pending()[0]! as { requestId: string; payer: `0x${string}` };
    w.chain.setAccount(payer, { code: '0x', nonce: 0n, balance: 0n });
    w.transcript.length = 0;
    expect(await w.cli('cancel', id, '--network', 'local', '--rpc', 'http://127.0.0.1:1', '--yes')).toBe(1);
    expect(w.err).toEqual([
      `${payer} doesn't have enough CELO to pay the gas for cancelAuthorization (up to 0.01 CELO). Nothing was sent.`,
      `Add CELO to ${payer} at faucet.celo.org/celo-sepolia, then run the command again.`,
    ]);
    expect(w.chain.calls).not.toContain('eth_sendRawTransaction');
    expect(w.pending()[0]!.state).not.toBe('not_charged');
  });

  it('attessa cancel --json when the node refuses the signed broadcast for funds: insufficient_gas_funds, node text not printed', async () => {
    await initialized();
    w.gw.behavior = { paid: 'refuse' };
    expect(await w.call('--no-wait')).toBe(1);
    const id = w.pending()[0]!.requestId as string;
    const orig = w.chain.request.bind(w.chain);
    w.chain.request = async (m: string, p: unknown[] = []) => {
      if (m === 'eth_sendRawTransaction') throw new RpcFailure('insufficient funds for gas * price + value: balance 0, tx cost 1, overshot 1 NODE-TEXT');
      return orig(m, p);
    };
    w.out.length = 0;
    expect(await w.cli('cancel', id, '--network', 'local', '--rpc', 'http://127.0.0.1:1', '--yes', '--json')).toBe(1);
    const out = JSON.parse(w.out.at(-1)!);
    expect(out).toMatchObject({ ok: false, error: 'insufficient_gas_funds' });
    expect(out.message).toMatch(/ Nothing was sent\.$/);
    expect(w.out.join('\n')).not.toMatch(/NODE-TEXT/);
  });

  it('attessa cancel after the payment went through: "Too late to cancel", then the answer', async () => {
    await initialized();
    w.gw.behavior = { paid: 'pending' };
    w.gw.behavior.pendingPolls = 1000;
    expect(await w.call('--no-wait')).toBe(1);
    const id = w.pending()[0]!.requestId as string;
    w.gw.release(id as Hex);
    w.transcript.length = 0;
    expect(await w.cli('cancel', id, '--network', 'local', '--rpc', 'http://127.0.0.1:1', '--yes')).toBe(0);
    expect(w.transcript[0]).toMatch(/^Too late to cancel: the payment went through \(tx 0x[0-9a-f]{4}…[0-9a-f]{2}\)\. Fetching your answer\.$/);
    expect(w.transcript.at(-1)).toBe(`Answer saved to ${id}.json. Record: ~/.attessa/evidence.jsonl`);
  });

  it('attessa status --pending resolves an open call from the chain', async () => {
    await initialized();
    w.gw.behavior = { paid: 'html502' };
    expect(await w.call('--no-wait')).toBe(1);
    const id = w.pending()[0]!.requestId as string;
    w.chain.advance(400);
    w.transcript.length = 0;
    expect(await w.cli('status', '--pending', '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    expect(w.transcript[0]).toBe(`${id}  ${w.host}`);
    expect(w.transcript[1]).toMatch(/^Not charged: confirmed on Celo, your payment permission expired unused {2}\(block [\d,]+\)$/);
    expect(w.pending()[0]!.state).toBe('not_charged');
  });

  it('attessa status <origin>: registry entry and a fresh liveness check', async () => {
    await initialized();
    expect(await w.cli('status', w.origin, '--network', 'local', '--rpc', 'http://127.0.0.1:1')).toBe(0);
    expect(w.transcript[0]).toBe(`${w.host}: agent 412, endpoint active, pays ${w.payTo}`);
    expect(w.transcript[1]).toMatch(/^It's up and answering for this address right now {2}\(liveness check, \d+\.\d s\)$/);
  });

  it('attessa evidence export: CSV with a header and one row per call; nothing recorded yet is a FLOWS refusal', async () => {
    await initialized();
    expect(await w.cli('evidence', 'export')).toBe(1);
    expect(w.err).toEqual(["No calls recorded yet, so there's nothing to export.", 'Make one with `attessa call`.']);
    expect(await w.call()).toBe(0);
    w.out.length = 0;
    expect(await w.cli('evidence', 'export', '--format', 'csv')).toBe(0);
    expect(w.out[0]).toBe('v,ts,requestId,origin,agentId,outcome,code,check,amount,asset,payTo,settlementTx,signer,releaseId,ownerClaimedSource,selfVerifiedOwner,requestHash,responseHash,inputsHash,inputsBlock,inputsChecked,via');
    expect(w.out).toHaveLength(2);
    expect(w.out[1]).toContain(',verified,');
  });
});

describe('buyer: T21 adversary r4 fixes beyond the adversary tests', () => {
  const LOCAL = ['--network', 'local', '--rpc', 'http://127.0.0.1:1'];

  // `status <origin>` used to turn every failed read into "Can't reach Celo"; a wrong network keeps its own row.
  it('status <origin> against an RPC on another chain prints the FLOWS wrong-network line', async () => {
    await initialized();
    expect(await w.cli('status', 'https://risk.example', '--network', 'mainnet', '--rpc', 'http://127.0.0.1:1')).toBe(1);
    expect(w.err).toEqual([`Your RPC is on chain ${w.chain.chainId}; this registry is on 42220.`, 'Set `--rpc` for 42220.']);
  });

  it('status --pending <origin> with a malformed origin is the FLOWS invalid-origin line, not "Unexpected error"', async () => {
    await initialized();
    expect(await w.cli('status', 'ftp://risk example', '--pending', ...LOCAL)).toBe(1);
    expect(w.err).toEqual(['Use just the scheme and host, like https://risk.example (no path, lowercase).']);
  });

  it('cancel --json against an RPC on another chain: error code network_mismatch', async () => {
    await initialized();
    w.gw.behavior = { paid: 'pending_no_settle' };
    expect(await w.call('--no-wait')).toBe(1);
    const id = w.pending()[0]!.requestId as string;
    w.out.length = 0;
    expect(await w.cli('cancel', id, '--network', 'mainnet', '--rpc', 'http://127.0.0.1:1', '--yes', '--json')).toBe(1);
    expect(JSON.parse(w.out.at(-1)!)).toMatchObject({ ok: false, error: 'network_mismatch' });
  });

  // A dry run with an open call for the same input says a real run would resume it, shows no price, signs nothing.
  it('--dry-run with an open call: the would-resume line, then the dry-run line, and no price line', async () => {
    await initialized();
    w.gw.behavior = { paid: 'pending_no_settle' };
    expect(await w.call('--no-wait')).toBe(1);
    const id = w.pending()[0]!.requestId as string;
    const before = JSON.stringify(w.pending());
    w.transcript.length = 0;
    expect(await w.call('--dry-run')).toBe(0);
    expect(w.transcript).toEqual([
      `Checking ${w.host} before paying`,
      `You already have a call in progress for this input (request ${id}). Without --dry-run, attessa resumes it instead of paying again.`,
      '  (dry run: nothing was signed)',
    ]);
    expect(JSON.stringify(w.pending())).toBe(before);
  });
});
