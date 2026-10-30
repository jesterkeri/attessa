import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { jcs } from '@attessa/core';
import { EnclaveClient, EnclaveUnreachable, TcpEnclaveTransport, configureMessage } from '../src/enclave.ts';
import { FakeEnclave } from './fake-enclave.ts';

const cfg = configureMessage({
  chainId: 11142220,
  registry: '0x00000000000000000000000000000000000000AA',
  agentId: 412n,
  origin: 'https://risk.example',
});

let enclave: FakeEnclave | null = null;
afterEach(async () => {
  await enclave?.stop();
  enclave = null;
});

describe('enclave client (SPEC §4.1, §4.2)', () => {
  it('sends configure as JCS with decimal-string ids, a lowercase registry and rpcAllowedChains', async () => {
    enclave = new FakeEnclave();
    const client = new EnclaveClient(new TcpEnclaveTransport(await enclave.start()));
    const r = await client.configureOrAttest(cfg, 2000);
    expect(r.configured).toBe(true);
    expect(r.signer).toBe(enclave.signer);
    const raw = enclave.rawFrames[0]!.toString('utf8');
    expect(raw).toBe(jcs(JSON.parse(raw)));
    expect(JSON.parse(raw)).toEqual({
      type: 'configure',
      chainId: '11142220',
      registry: '0x00000000000000000000000000000000000000aa',
      agentId: '412',
      origin: 'https://risk.example',
      rpcAllowedChains: ['11142220'],
    });
  });

  it('falls back to attest when the enclave was already configured this boot (INV-22)', async () => {
    enclave = new FakeEnclave();
    const client = new EnclaveClient(new TcpEnclaveTransport(await enclave.start()));
    await client.configureOrAttest(cfg, 2000);
    const again = await client.configureOrAttest({ ...cfg, agentId: '999' }, 2000);
    expect(again.configured).toBe(false);
    expect(again.signer).toBe(enclave.signer);
    expect(enclave.configureCount).toBe(1);
    expect(enclave.config!.agentId).toBe(412n);
    expect(enclave.received.map((m) => m.type)).toEqual(['configure', 'configure', 'attest']);
  });

  it('throws when configure is refused and the enclave is not configured', async () => {
    enclave = new FakeEnclave();
    const client = new EnclaveClient(new TcpEnclaveTransport(await enclave.start()));
    await expect(client.configureOrAttest({ ...cfg, origin: 'not a url' }, 2000)).rejects.toThrow(/refused attest: not_configured/);
  });

  it('reports a closed port as EnclaveUnreachable', async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const client = new EnclaveClient(new TcpEnclaveTransport(port));
    await expect(client.attest(1000)).rejects.toBeInstanceOf(EnclaveUnreachable);
  });

  it('times out with name TimeoutError when the enclave never answers', async () => {
    enclave = new FakeEnclave({ delayMs: 1500 });
    const client = new EnclaveClient(new TcpEnclaveTransport(await enclave.start()));
    const err = await client.attest(200).catch((e: Error) => e);
    expect((err as Error).name).toBe('TimeoutError');
  });

  it('treats a reply with an oversized length as a protocol failure', async () => {
    const srv = createServer((s) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(70_000, 0);
      s.end(b);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const client = new EnclaveClient(new TcpEnclaveTransport((srv.address() as AddressInfo).port));
    const err = await client.attest(1000).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/malformed frame/);
    srv.close();
  });
});
