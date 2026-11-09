// Builds the `attessa` npm package into packages/cli/npm/out: one bundled file, no runtime dependencies, no native code.
// Releasing it is Joshua's, from a commit that has been through the review chain.
import { cpSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..');
const out = join(here, 'out');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });
buildSync({
  entryPoints: [join(cli, 'src', 'bin.ts')],
  outfile: join(out, 'dist', 'bin.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['node'],
  legalComments: 'none',
  // Only the operator's gateway and the seller's guard database use these, and neither runs from this package.
  alias: { '@attessa/gateway': join(here, 'stubs', 'gateway.mjs'), 'better-sqlite3': join(here, 'stubs', 'better-sqlite3.mjs') },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
cpSync(join(here, 'attessa.mjs'), join(out, 'dist', 'attessa.mjs'));
chmodSync(join(out, 'dist', 'attessa.mjs'), 0o755);
cpSync(join(cli, 'vendor'), join(out, 'vendor'), { recursive: true });
cpSync(join(here, 'README.md'), join(out, 'README.md'));
const version = JSON.parse(readFileSync(join(here, 'version.json'), 'utf8')).version;
writeFileSync(join(out, 'package.json'), `${JSON.stringify({
  name: 'attessa',
  version,
  description: 'Attessa command line: check what a paid agent service really ran, and pay it on Celo.',
  type: 'module',
  bin: { attessa: 'dist/attessa.mjs', attest: 'dist/attessa.mjs' },
  files: ['dist', 'vendor', 'README.md'],
  engines: { node: '>=22.13' },
  license: 'UNLICENSED',
  repository: { type: 'git', url: 'git+https://github.com/jesterkeri/attessa.git' },
  homepage: 'https://attessa.xyz',
}, null, 2)}\n`);
console.log(`built attessa ${version} in ${out}`);
