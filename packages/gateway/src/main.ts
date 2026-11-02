#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RpcChain } from './chain.ts';
import { defaultRpcUrl, loadConfig } from './config.ts';
import { CallStore } from './db.ts';
import { HttpFacilitator } from './facilitator.ts';
import { createGateway } from './gateway.ts';
import { HttpSellerHost } from './sellerhost.ts';

/** `node dist/main.js <gateway.config.json>`: the systemd `attessa-gw@<network>` entry point (SPEC §6.5). */
export async function main(configPath: string): Promise<void> {
  const cfg = loadConfig(configPath);
  const rpc = process.env.RPC_URL ?? defaultRpcUrl(cfg);
  if (!rpc) throw new Error('RPC_URL is required for this network');
  if (!process.env.FACILITATOR_API_KEY) process.stderr.write('warning: FACILITATOR_API_KEY is not set\n');
  const db = new CallStore(cfg.dbPath);
  const gw = createGateway({
    cfg,
    db,
    chain: new RpcChain(rpc),
    facilitator: new HttpFacilitator(cfg.facilitatorUrl, process.env.FACILITATOR_API_KEY, cfg.facilitatorAuthHeader, cfg.facilitatorAuthPrefix),
    sellerHost: new HttpSellerHost(cfg.sellerHostUrl),
  });
  await gw.start();
  await gw.app.listen({ host: cfg.listen.host, port: cfg.listen.port });
  const stop = async () => {
    await gw.close();
    db.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write('usage: attessa-gateway-server <gateway.config.json>\n');
    process.exit(2);
  }
  main(path).catch((e: unknown) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}
