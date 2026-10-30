import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrameReader, encodeFrame } from '../../seller-host/src/framing.ts';
import { jcs } from '@attessa/core';
import { FakeEnclave } from '../../seller-host/test/fake-enclave.ts';
import { ORIGIN, world, type World } from './harness.ts';

/**
 * Adversary T15 round 3. SPEC §5 pins each network's enclave CID and host socat port (mainnet CID 16 behind
 * 127.0.0.1:5005, Sepolia CID 17 behind 127.0.0.1:5007); seller-host now refuses any other port so the two
 * networks can't be crossed. `attessa enclave start` still pairs the network's CID with any `--port`, so it
 * runs one enclave and configures another.
 */

let w: World;
let server: Server | null = null;
beforeEach(() => {
  w = world();
  w.files.set('/srv/risk/build/risk.eif', Buffer.from('eif'));
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

/** A fresh, unconfigured enclave answering where socat puts the mainnet enclave (CID 16) per SPEC §5. */
async function mainnetEnclaveAt5005(): Promise<FakeEnclave> {
  const e = new FakeEnclave();
  server = createServer((sock) => {
    const reader = new FrameReader();
    sock.on('data', async (chunk) => {
      for (const f of reader.push(chunk)) sock.write(encodeFrame(Buffer.from(jcs(await e.handle(f)), 'utf8')));
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(5005, '127.0.0.1', () => resolve());
  });
  return e;
}

describe('adversary r3: enclave start can cross the mainnet and Sepolia enclaves', () => {
  it('--network sepolia (default) with --port 5005 starts CID 17 but must not configure the mainnet enclave', async () => {
    const mainnet = await mainnetEnclaveAt5005();
    const code = await w.cli('enclave', 'start', '--agent', '412', '--origin', ORIGIN, '--port', '5005');
    // Expected: refused before anything runs, like seller-host's "enclavePort must be 5007 on sepolia".
    expect({ code, started: w.runs.map((r) => r.args.at(-1)), mainnetConfiguredWith: mainnet.config?.chainId ?? null }).toEqual({
      code: 1,
      started: [],
      mainnetConfiguredWith: null,
    });
  });
});
