import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// The gateway's own store writes the rows, so the schema and WAL mode are the real ones (SPEC §6.4).
import { CallStore } from '../../gateway/src/db.ts';
import { parseConfig } from '../src/config.ts';
import { TcpEnclaveTransport } from '../src/enclave.ts';
import { encodeFrame } from '../src/framing.ts';
import { BuySpendGuard, GatewayDbRevenue, ONE_USDC } from '../src/guard.ts';

/** Adversary pass on T15 (seller-host side). In-process sockets and temp SQLite files only. */

const dirs: string[] = [];
const servers: Server[] = [];
const socks = new Set<Socket>();
afterEach(async () => {
  for (const s of socks) s.destroy();
  socks.clear();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'adv-t15-'));
  dirs.push(d);
  return d;
}

/** A TCP peer that answers every connection with `reply(sock)`. */
async function rawEnclave(reply: (sock: Socket) => void): Promise<number> {
  const srv = createServer((sock) => {
    socks.add(sock);
    sock.once('data', () => reply(sock));
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return (srv.address() as AddressInfo).port;
}

describe('adversary T15: enclave framing (SPEC §4.2)', () => {
  it('a length prefix that promises more bytes than arrive, on a socket left open, ends as a timeout, not a hang', async () => {
    const port = await rawEnclave((s) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(100, 0);
      s.write(Buffer.concat([b, Buffer.from('{"a":1}')]));
    });
    const t0 = Date.now();
    await expect(new TcpEnclaveTransport(port).request({ type: 'attest' }, 300)).rejects.toThrow(/did not answer within 300 ms/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a reply split one byte per write is reassembled', async () => {
    const port = await rawEnclave((s) => {
      const f = encodeFrame(Buffer.from('{"attestation":"AA==","signer":"0x1111111111111111111111111111111111111111"}'));
      let i = 0;
      const tick = () => {
        if (i < f.length) s.write(f.subarray(i, ++i), () => setImmediate(tick));
      };
      tick();
    });
    const r = await new TcpEnclaveTransport(port).request({ type: 'attest' }, 2000);
    expect(r.signer).toBe('0x1111111111111111111111111111111111111111');
  });

  it('a reply prefix of 65,537 or 0 is refused as malformed', async () => {
    for (const len of [65_537, 0]) {
      const port = await rawEnclave((s) => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(len, 0);
        s.write(b);
      });
      await expect(new TcpEnclaveTransport(port).request({ type: 'attest' }, 1000)).rejects.toThrow(/malformed frame/);
    }
  });

  it('a request frame of exactly 65,536 bytes is accepted and 65,537 refused', () => {
    expect(encodeFrame(Buffer.alloc(65_536, 0x20)).length).toBe(65_540);
    expect(() => encodeFrame(Buffer.alloc(65_537, 0x20))).toThrow();
  });
});

describe('adversary T15: /internal routes stay on loopback (SPEC §5)', () => {
  it('a config that listens on 0.0.0.0 or a public address is refused', () => {
    const base = { network: 'sepolia', registry: '0x00000000000000000000000000000000000000aa', agentId: '412', origin: 'https://risk.example', stateDir: '/tmp/x' };
    for (const host of ['0.0.0.0', '::', '10.0.0.5']) expect(() => parseConfig({ ...base, listen: { host } })).toThrow(/loopback only/);
    expect(parseConfig(base).listen).toEqual({ host: '127.0.0.1', port: 7071 });
  });
});

const DAY = Date.UTC(2026, 9, 30) / 1000; // 2026-10-30 00:00:00 UTC

function insertSettled(store: CallStore, id: string, amount: string, settledAt: number): void {
  const requestId = `0x${id.padStart(64, '0')}`;
  store.insertVerified(
    {
      request_id: requestId,
      payer: '0x2222222222222222222222222222222222222222',
      asset: '0x01c5c0122039549ad1493b8220cabedd739bc44e',
      pay_to: '0x1111111111111111111111111111111111111111',
      amount,
      auth_nonce: `0x${id.padStart(64, 'f')}`,
      valid_before: settledAt + 60,
      request_hash: `0x${'ab'.repeat(32)}`,
      created_block: 1,
    },
    settledAt - 5,
  );
  expect(store.transition(requestId, ['payment_verified'], 'executing', settledAt - 4)).toBe(true);
  expect(store.transition(requestId, ['executing'], 'settling', settledAt - 2)).toBe(true);
  expect(store.transition(requestId, ['settling'], 'settled', settledAt)).toBe(true);
}

describe('adversary T15: buy-spend guard (SPEC §5)', () => {
  it('reads settled revenue from a WAL database while the gateway holds it open', () => {
    const path = join(tmp(), 'sepolia.db');
    const store = new CallStore(path);
    try {
      insertSettled(store, '1', '2500000', DAY + 3600);
      expect(new GatewayDbRevenue(path).settledSince(DAY)).toBe(2_500_000n);
    } finally {
      store.close();
    }
  });

  it('a missing database counts as zero revenue: 1 USDC of reads, then Forno', () => {
    const d = tmp();
    const guard = new BuySpendGuard(join(d, 'guard.json'), new GatewayDbRevenue(join(d, 'absent.db')));
    const now = new Date((DAY + 60) * 1000);
    expect(guard.allow(ONE_USDC, now)).toBe(true);
    guard.record(ONE_USDC, now);
    expect(guard.allow(1n, now)).toBe(false);
    expect(guard.state(now).tripped).toBe(true);
  });

  // SPEC §5: "if it exceeds the gateway's settled revenue for the day + 1 USDC". A call settled at
  // 23:59:50 on the 29th is the 29th's revenue. The reconciler moves an undelivered `settled` row to
  // `delivery_failed` 30 s later (SPEC §6.3), which here lands at 00:00:21 on the 30th.
  it('revenue settled before midnight is not counted again in the next day', () => {
    const path = join(tmp(), 'sepolia.db');
    const store = new CallStore(path);
    try {
      insertSettled(store, '2', '5000000', DAY - 10);
      expect(store.transition(`0x${'2'.padStart(64, '0')}`, ['settled'], 'delivery_failed', DAY + 21)).toBe(true);
      const rev = new GatewayDbRevenue(path);
      expect(rev.settledSince(DAY - 86_400)).toBe(5_000_000n);
      expect(rev.settledSince(DAY)).toBe(0n);
    } finally {
      store.close();
    }
  });
});
