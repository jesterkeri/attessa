#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { EnclaveClient, TcpEnclaveTransport } from './enclave.ts';
import { HttpRpcSource, InputFetcher } from './inputs.ts';
import { SellerHost } from './server.ts';

/**
 * `attessa-seller-host <config.json>`, run by `attessa-seller@<network>.service`. Reads go to Forno for now:
 * the buy RPC capability (S7) plugs in as a `BuySource` behind the budget guard once its API is known.
 */
function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

export async function main(path: string): Promise<void> {
  const cfg = loadConfig(path);
  const host = new SellerHost({
    config: cfg,
    enclave: new EnclaveClient(new TcpEnclaveTransport(cfg.enclavePort)),
    inputs: new InputFetcher({ forno: new HttpRpcSource('forno', cfg.fornoUrl), log }),
    log,
  });
  const port = await host.listen(cfg.listen.port, cfg.listen.host);
  log('listening', { network: cfg.network, port, enclavePort: cfg.enclavePort });
  await host.configureEnclave();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write('usage: attessa-seller-host <seller-host.config.json>\n');
    process.exit(2);
  }
  main(path).catch((e: unknown) => {
    log('fatal', { reason: (e as Error).message });
    process.exit(1);
  });
}
