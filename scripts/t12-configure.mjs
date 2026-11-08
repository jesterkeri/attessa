#!/usr/bin/env node
// T12 spike: sends one `configure` (SPEC §4.1 step 2) to the enclave behind a local socat port and writes the
// attestation it answers with to <out> as raw COSE bytes. Retries while the enclave boots (up to 60 s).
// The binding values are placeholders: the spike checks field sizes, not a registration.
// Needs `pnpm -r build`. Usage: node scripts/t12-configure.mjs <port> <out>
import { writeFileSync } from 'node:fs';
import { configureMessage, EnclaveClient, TcpEnclaveTransport } from '../packages/seller-host/dist/index.js';

const [port, out] = [Number(process.argv[2]), process.argv[3]];
if (!Number.isInteger(port) || !out) {
  console.error('usage: node scripts/t12-configure.mjs <port> <out>');
  process.exit(2);
}
const client = new EnclaveClient(new TcpEnclaveTransport(port));
// configureMessage is what the seller host sends: the enclave takes only lowercase hex, and it lowercases the address.
const cfg = configureMessage({
  chainId: 11142220,
  registry: '0x42Bf5Cb440c3C321CB42b0F4c81c3c7435cB92fF', // Celo Sepolia EnclaveRegistry (packages/core/src/deployments.ts)
  agentId: '1',
  origin: 'https://spike.example',
});
let last;
for (let i = 0; i < 30; i++) {
  try {
    const a = await client.configureOrAttest(cfg, 10_000);
    writeFileSync(out, Buffer.from(a.attestation, 'base64'));
    console.log(`attestation written to ${out} (signer ${a.signer}, ${a.configured ? 'configured now' : 'already configured'})`);
    process.exit(0);
  } catch (e) {
    last = e;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
console.error(`no attestation from 127.0.0.1:${port} after 60 s: ${last?.message ?? last}`);
process.exit(1);
