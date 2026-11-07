import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.ts';
import { EnclaveClient, EnclaveMismatch, TcpEnclaveTransport, configureMessage } from '../src/enclave.ts';
import { encodeFrame } from '../src/framing.ts';
import { HttpRpcSource, InputFetcher } from '../src/inputs.ts';
import { SellerHost } from '../src/server.ts';
import { FakeEnclave } from './fake-enclave.ts';

/** Codex review r1 on T15: M2 (no crossed networks at boot) and m1 (framed replies are JCS). */

const REGISTRY = '0x00000000000000000000000000000000000000aa';
const ORIGIN = 'https://risk.example';
const SEPOLIA = { chainId: 11142220, registry: REGISTRY, agentId: 412n, origin: ORIGIN };

let enclave: FakeEnclave | null = null;
let host: SellerHost | null = null;
const servers: Server[] = [];
afterEach(async () => {
  await host?.close();
  await enclave?.stop();
  host = enclave = null;
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

describe('M2: seller-host config pins the SPEC §5 ports per network', () => {
  const base = { registry: REGISTRY, agentId: '412', origin: ORIGIN, stateDir: '/var/lib/attessa/seller' };

  it("refuses another network's socat or HTTP port", () => {
    expect(() => parseConfig({ ...base, network: 'sepolia', enclavePort: 5005 })).toThrow(/enclavePort must be 5007 on sepolia/);
    expect(() => parseConfig({ ...base, network: 'mainnet', enclavePort: 5007 })).toThrow(/enclavePort must be 5005 on mainnet/);
    expect(() => parseConfig({ ...base, network: 'sepolia', listen: { port: 7070 } })).toThrow(/listen.port must be 7071 on sepolia/);
  });

  it('accepts the fixed port spelled out, and any port on local', () => {
    expect(parseConfig({ ...base, network: 'sepolia', enclavePort: 5007, listen: { port: 7071 } })).toMatchObject({ enclavePort: 5007, listen: { port: 7071 } });
    expect(parseConfig({ ...base, network: 'local', chainId: 31337, enclavePort: 6000, listen: { port: 7000 }, fornoUrl: 'http://127.0.0.1:8545' })).toMatchObject({ enclavePort: 6000 });
  });
});

describe('M2: seller-host boot fails closed on an enclave bound elsewhere', () => {
  async function bootAgainst(e: FakeEnclave): Promise<{ logs: string[] }> {
    enclave = e;
    const port = await e.start();
    const logs: string[] = [];
    host = new SellerHost({
      config: SEPOLIA,
      enclave: new EnclaveClient(new TcpEnclaveTransport(port)),
      inputs: new InputFetcher({ forno: new HttpRpcSource('forno', 'http://127.0.0.1:1') }),
      log: (ev) => logs.push(ev),
    });
    return { logs };
  }

  it('an enclave already configured for mainnet is refused at once, without retrying', async () => {
    const { logs } = await bootAgainst(new FakeEnclave());
    await enclave!.handle(Buffer.from(JSON.stringify({ type: 'configure', ...configureMessage({ ...SEPOLIA, chainId: 42220 }) })));
    const err = await host!.configureEnclave({ maxAttempts: 5, retryMs: 10 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(EnclaveMismatch);
    expect(logs.filter((l) => l === 'enclave_configure_failed')).toHaveLength(1);
    expect(logs).not.toContain('enclave_already_configured');
  });

  for (const [what, other] of [
    ['agent', { agentId: 7n }],
    ['registry', { registry: '0x00000000000000000000000000000000000000bb' }],
    ['origin', { origin: 'https://other.example' }],
  ] as const) {
    it(`an enclave already configured for another ${what} is refused`, async () => {
      await bootAgainst(new FakeEnclave());
      await enclave!.handle(Buffer.from(JSON.stringify({ type: 'configure', ...configureMessage({ ...SEPOLIA, ...other }) })));
      await expect(host!.configureEnclave({ maxAttempts: 1 })).rejects.toBeInstanceOf(EnclaveMismatch);
    });
  }

  it('an attestation that cannot be parsed is refused, even right after configuring', async () => {
    await bootAgainst(new FakeEnclave({ makeAttestation: () => randomBytes(64) }));
    await expect(host!.configureEnclave({ maxAttempts: 3, retryMs: 10 })).rejects.toThrow(/unreadable/);
  });

  it('the matching enclave still boots, configured or already configured', async () => {
    await bootAgainst(new FakeEnclave());
    expect(await host!.configureEnclave({ maxAttempts: 1 })).toEqual({ signer: enclave!.signer, configured: true });
    expect(await host!.configureEnclave({ maxAttempts: 1 })).toEqual({ signer: enclave!.signer, configured: false });
  });
});

describe('m1: framed enclave replies must be JCS (SPEC §4.2)', () => {
  async function replying(text: string): Promise<number> {
    const srv = createServer((s) => s.once('data', () => s.write(encodeFrame(Buffer.from(text, 'utf8')))));
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    return (srv.address() as AddressInfo).port;
  }

  for (const text of ['{"z":1,"a":2}', '{ "a":2}', '{"a":2.0}', '{"a":"\\u0062"}']) {
    it(`refuses ${text}`, async () => {
      await expect(new TcpEnclaveTransport(await replying(text)).request({ type: 'attest' }, 1000)).rejects.toThrow(/not JCS/);
    });
  }

  it('accepts the canonical form', async () => {
    expect(await new TcpEnclaveTransport(await replying('{"a":2,"z":1}')).request({ type: 'attest' }, 1000)).toEqual({ a: 2, z: 1 });
  });
});
