#!/usr/bin/env node
import { appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { EnclaveClient, TcpEnclaveTransport } from './enclave.ts';
import { BuyPaidSource, loadAgentAccount } from './buy.ts';
import { BuyIntentLedger } from './ledger.ts';
import { BuySpendGuard, GatewayDbRevenue } from './guard.ts';
import { HttpRpcSource, InputFetcher } from './inputs.ts';
import { SellerHost } from './server.ts';

/**
 * `attessa-seller-host <config.json>`, run by `attessa-seller@<network>.service`. Reads go to Forno unless the
 * config has a `buy` block (mainnet only) and env AGENT_PRIVATE_KEY holds a valid key: then buy is primary behind the budget guard, Forno the fallback.
 */
function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

export async function main(path: string): Promise<void> {
  const cfg = loadConfig(path);
  // The agent wallet key comes from env only and stays in memory. Without a usable key paid reads are off and every read goes to Forno.
  let buy: BuyPaidSource | null = null;
  const ledger = new BuyIntentLedger(join(cfg.stateDir, 'buy-intents.jsonl'));
  if (cfg.buy) {
    const key = loadAgentAccount();
    if (key.ok) {
      const receipts = join(cfg.stateDir, 'buy-receipts.jsonl');
      buy = new BuyPaidSource(cfg.buy, key.account, undefined, (r) => {
        log('buy_paid', { capabilityId: r.capabilityId, amount: r.amount, outcome: r.outcome, txHash: r.txHash, from: r.from, nonce: r.nonce }); // first: survives a failed write
        appendFileSync(receipts, `${JSON.stringify(r)}\n`, { mode: 0o600 });
      }, ledger);
    }
    else log('buy_disabled', { reason: key.reason, fallback: 'forno' });
  }
  const host = new SellerHost({
    config: cfg,
    enclave: new EnclaveClient(new TcpEnclaveTransport(cfg.enclavePort)),
    inputs: new InputFetcher({
      forno: new HttpRpcSource('forno', cfg.fornoUrl),
      ...(buy
        ? { buy, guard: new BuySpendGuard(join(cfg.stateDir, 'buy-guard.json'), new GatewayDbRevenue(cfg.gatewayDbPath!, log), log, ledger) }
        : {}),
      log,
    }),
    log,
  });
  // Serve only once the enclave is known to be bound to this config (fail closed).
  await host.configureEnclave();
  const port = await host.listen(cfg.listen.port, cfg.listen.host);
  log('listening', { network: cfg.network, port, enclavePort: cfg.enclavePort, buy: buy !== null });
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
