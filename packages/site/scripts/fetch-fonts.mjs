// Vendors the site's fonts (Anybody, Geist, Geist Mono; SIL Open Font License) so the pages load nothing from Google.
// Run once, by hand, when the families change: node packages/site/scripts/fetch-fonts.mjs
// It asks Google Fonts for the same CSS the site used to link, keeps the latin and latin-ext subsets, downloads
// each woff2, and writes src/static/assets/fonts/*.woff2, assets/fonts.css and assets/fonts/SHA256SUMS
// (the manifest test/no-third-party-origins.test.mjs checks the files against). The woff2 files are committed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'static', 'assets');
const dir = join(assets, 'fonts');
const CSS = 'https://fonts.googleapis.com/css2?family=Anybody:wdth,wght@50..150,300..800&family=Geist:wght@300..700&family=Geist+Mono:wght@400;500&display=swap';
// A browser user agent makes Google answer with woff2 files.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const KEEP = new Set(['latin', 'latin-ext']);

const css = await (await fetch(CSS, { headers: { 'user-agent': UA } })).text();
mkdirSync(dir, { recursive: true });
const sums = [];
let out = '/* Vendored by scripts/fetch-fonts.mjs: latin and latin-ext subsets of Anybody, Geist and Geist Mono (SIL OFL 1.1). */\n';
for (const m of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)) {
  const [, subset, face] = m;
  if (!KEEP.has(subset)) continue;
  const family = /font-family:\s*'([^']+)'/.exec(face)[1];
  const weight = /font-weight:\s*([\d ]+);/.exec(face)[1].trim().replace(/ /g, '-');
  const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(face)[1];
  const bytes = Buffer.from(await (await fetch(url, { headers: { 'user-agent': UA } })).arrayBuffer());
  const name = `${family.toLowerCase().replace(/ /g, '-')}-${weight}-${subset}.woff2`;
  writeFileSync(join(dir, name), bytes);
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  out += `${face.replace(url, `fonts/${name}`).replace(/ format\('woff2'\)/, " format('woff2')")}\n`;
  console.log(name, bytes.length);
}
writeFileSync(join(assets, 'fonts.css'), out);
writeFileSync(join(dir, 'SHA256SUMS'), `${sums.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join('\n')}\n`);
