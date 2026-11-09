// Tests only, loaded with `node --import`: builds the site as it will be once a network is deployed, by laying
// SITE_TEST_DEPLOYMENTS over the deploy record @attessa/core exports. build.mjs and config.mjs have no such input, and
// build.mjs refuses the variable if it arrives without this file, so no build a deploy runs can carry a fake record.
import { registerHooks } from 'node:module';

const WRAPPED = 'attessa-test:core';
const record = process.env.SITE_TEST_DEPLOYMENTS ?? '{}';
delete process.env.SITE_TEST_DEPLOYMENTS;
let real;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== '@attessa/core') return next(specifier, context);
    real = next(specifier, context).url;
    return { url: WRAPPED, shortCircuit: true };
  },
  load(url, context, next) {
    if (url !== WRAPPED) return next(url, context);
    const source = `import { DEPLOYMENTS as d } from ${JSON.stringify(real)};
export * from ${JSON.stringify(real)};
const r = ${record};
export const DEPLOYMENTS = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { ...v, ...r[k] }]));`;
    return { format: 'module', source, shortCircuit: true };
  },
});
