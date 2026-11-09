// Tests only, loaded with `node --import`: builds the site as it will be once a network is deployed, by laying
// SITE_TEST_DEPLOYMENTS over the deploy record @attessa/core exports. build.mjs and config.mjs have no such input, and
// build.mjs refuses the variable if it arrives without this file, so no build a deploy runs can carry a fake record.
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

// Only a command line that names this file, building into the temp directory. NODE_OPTIONS doesn't show in execArgv, so
// it can't slip this into a build, and a real output directory is refused: what this makes must not be something to deploy.
if (!process.execArgv.some((a) => a.endsWith('test-record.mjs'))) throw new Error('test-record.mjs must be named on the node command line, not through NODE_OPTIONS');
if (!resolve(process.env.SITE_OUT ?? '.').startsWith(resolve(tmpdir()) + sep)) throw new Error('test-record.mjs builds only into the temp directory: SITE_OUT must be under it');

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
