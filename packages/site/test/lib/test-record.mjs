// Tests only, loaded with `node --import`: builds the site as it will be once a network is deployed, by laying
// SITE_TEST_DEPLOYMENTS over the deploy record @attessa/core exports. build.mjs and config.mjs have no such input, and
// build.mjs refuses the variable if it arrives without this file, so no build a deploy runs can carry a fake record.
import { registerHooks } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only a command line that names this file, building into a named folder in the temp directory and outside this repo.
// NODE_OPTIONS doesn't show in execArgv. Without SITE_OUT the build writes dist whatever the cwd. Symlinks are resolved first,
// and TMPDIR can't make a folder in the repo count. What this builds must not be something to deploy.
if (!process.execArgv.some((a) => a.endsWith('test-record.mjs'))) throw new Error('test-record.mjs must be named on the node command line, not through NODE_OPTIONS');
/** The real path of a folder that may not exist yet: its nearest existing parent resolved, then the rest. */
function real(path) {
  const rest = [];
  let at = resolve(path);
  while (!existsSync(at)) {
    rest.unshift(basename(at));
    at = dirname(at);
  }
  return join(realpathSync(at), ...rest);
}
const inside = (path, folder) => path.startsWith(folder + sep);
const repo = real(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'));
const output = process.env.SITE_OUT ? real(process.env.SITE_OUT) : null;
if (!output || !inside(output, real(tmpdir())) || inside(output, repo)) throw new Error('test-record.mjs builds only into the temp directory: SITE_OUT must be under it, and outside this repo');

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
