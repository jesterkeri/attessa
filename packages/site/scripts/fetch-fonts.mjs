// Vendors the site's fonts (Anybody, Geist, Geist Mono; SIL Open Font License) so the pages load nothing from Google.
// Run once, by hand, when the families change: node packages/site/scripts/fetch-fonts.mjs
// It asks Google Fonts for the same CSS the site used to link, keeps the latin and latin-ext subsets, downloads
// each woff2, and writes src/static/assets/fonts/*.woff2, assets/fonts.css, assets/fonts/SHA256SUMS, one SIL OFL 1.1 licence
// file per family (licenses/, from the upstream repository at a pinned commit) and fonts/PROVENANCE.json (family, upstream,
// Google Fonts version, licence file and sha256, fetch date, file sha256). test/font-provenance.test.mjs checks them. All committed.
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
// Upstream sources of the licence text, pinned to the commit that was the default branch's head when this was recorded.
const UPSTREAM = {
  Anybody: { repo: 'https://github.com/Etcetera-Type-Co/Anybody', commit: 'fe7b55cf9d1563348ad95ac8e05f43b81a420c31', licence: 'OFL.txt' },
  Geist: { repo: 'https://github.com/vercel/geist-font', commit: 'ef2597cfc42f4797676df105517ccc0a1cfa6569', licence: 'OFL.txt' },
  'Geist Mono': { repo: 'https://github.com/vercel/geist-font', commit: 'ef2597cfc42f4797676df105517ccc0a1cfa6569', licence: 'OFL.txt' },
};

const css = await (await fetch(CSS, { headers: { 'user-agent': UA } })).text();
mkdirSync(dir, { recursive: true });
const sums = [];
const files = {};
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
  const sha = createHash('sha256').update(bytes).digest('hex');
  sums.push(`${sha}  ${name}`);
  (files[family] ??= []).push({ name, subset, sha256: sha, googleFontsUrl: url, googleFontsVersion: /\/s\/[a-z]+\/(v\d+)\//.exec(url)?.[1] ?? null });
  out += `${face.replace(url, `fonts/${name}`).replace(/ format\('woff2'\)/, " format('woff2')")}\n`;
  console.log(name, bytes.length);
}
writeFileSync(join(assets, 'fonts.css'), out);
writeFileSync(join(dir, 'SHA256SUMS'), `${sums.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join('\n')}\n`);

// Licences and provenance.
mkdirSync(join(dir, 'licenses'), { recursive: true });
const families = [];
for (const [family, up] of Object.entries(UPSTREAM)) {
  const url = `${up.repo.replace('https://github.com', 'https://raw.githubusercontent.com')}/${up.commit}/${up.licence}`;
  const text = Buffer.from(await (await fetch(url)).arrayBuffer());
  if (!text.toString('utf8').includes('SIL OPEN FONT LICENSE Version 1.1')) throw new Error(`${url} is not the SIL OFL 1.1`);
  const file = `OFL-${family.replace(/ /g, '-')}.txt`;
  writeFileSync(join(dir, 'licenses', file), text);
  families.push({
    family, upstreamRepo: up.repo, upstreamCommit: up.commit, licence: 'SIL Open Font License 1.1',
    licenceFile: `licenses/${file}`, licenceUrl: url, licenceSha256: createHash('sha256').update(text).digest('hex'),
    copyright: /^Copyright.*$/m.exec(text.toString('utf8'))?.[0] ?? null,
    files: files[family] ?? [],
  });
}
writeFileSync(join(dir, 'PROVENANCE.json'), `${JSON.stringify({
  note: 'The woff2 files are the latin and latin-ext subsets Google Fonts serves for these families (googleFontsVersion is the version in its URL). The licence text is each upstream repository\'s OFL.txt at upstreamCommit; Google Fonts does not say which upstream commit built its files.',
  fetchedAt: new Date().toISOString().slice(0, 10), source: CSS, families,
}, null, 2)}\n`);
