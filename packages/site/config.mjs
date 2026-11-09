// The site's network configuration, built from @attessa/core DEPLOYMENTS (every address) and networks.json
// (RPC, block explorer, labels, demo origin). Written to assets/config.js as window.ATTESSA_CONFIG.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENTS } from '@attessa/core';

const here = dirname(fileURLToPath(import.meta.url));
const extra = JSON.parse(readFileSync(join(here, 'networks.json'), 'utf8'));

/** @param {string} coreKey */
function network(coreKey) {
  const d = /** @type {Record<string, any>} */ (DEPLOYMENTS)[coreKey];
  const x = extra[coreKey];
  if (!d.chainId || !x) throw new Error(`networks.json and DEPLOYMENTS disagree about ${coreKey}`);
  const tokens = Object.entries(d.assets).map(([k, a]) => {
    const t = extra.tokens[k];
    if (!t) throw new Error(`networks.json has no symbol and decimals for ${k}`);
    return { key: k, address: /** @type {any} */ (a).address, symbol: t.symbol, decimals: t.decimals };
  });
  return {
    coreKey,
    label: x.label,
    chainId: d.chainId,
    rpc: x.rpc,
    explorer: x.explorer,
    demoOrigin: x.demoOrigin,
    // The switch offers a network only once Attessa's registry is deployed on it.
    enabled: d.enclaveRegistry !== null,
    contracts: {
      enclaveRegistry: d.enclaveRegistry,
      identityRegistry: d.identityRegistry,
      selfRegistry: d.selfRegistry,
      ...(d.validatorStack ?? {}),
    },
    tokens,
  };
}

export const NETWORK_KEYS = Object.fromEntries(['celo-sepolia', 'celo'].map(k => [extra[k].key, k]));
export const config = { networks: Object.fromEntries(Object.entries(NETWORK_KEYS).map(([siteKey, coreKey]) => [siteKey, network(coreKey)])) };

/** The value of `[[chain:<network>.<name>]]`: network is a core key (celo-sepolia, celo); name a contract or a token key. */
export function chainValue(ref) {
  const m = /^(celo-sepolia|celo)\.(\w+)$/.exec(ref);
  if (!m) throw new Error(`bad chain reference ${ref}`);
  const n = Object.values(config.networks).find(x => x.coreKey === m[1]);
  const v = n?.contracts[m[2]] ?? n?.tokens.find(t => t.key === m[2])?.address;
  if (!v) throw new Error(`[[chain:${ref}]]: the deploy record has no value yet (write the "After launch" text instead)`);
  return v;
}

/** Slot names whose value a deploy record can hold: a [[slot:name]] with one of these is a build error. */
export function deployedSlotNames() {
  const names = new Set();
  for (const n of Object.values(config.networks)) {
    for (const [k, v] of Object.entries(n.contracts)) if (v) names.add(k);
    for (const t of n.tokens) names.add(t.key);
  }
  return names;
}
