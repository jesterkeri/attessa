// Builds the static site: node build.mjs (SITE_OUT=<folder> writes somewhere other than dist/)
// Each src/pages/**.html is wrapped in src/layout.html and written to dist/ at the same path.
// Page header comments set metadata: <!-- title: ... -->, <!-- description: ... -->, <!-- nav: ... -->, <!-- doc: ... -->
// Shorthands expanded at build time:
//   {{root}}          relative path back to the site root, so pages work from file:// and any host path
//   {{seal}}          the proof seal SVG (guilloche ring + five check segments); {{seal:pass pass fail na pass}} bakes states
//   {{sealMini:...}}  the small seal for outcome rows, no guilloche
//   {{ring:...}}      the five-segment proof ring used by the dark homepage
//   {{logo}}          the small seal glyph
//   {{> name}}        src/partials/name.html
//   [[slot:name]]     a sample slot chip, shown as {name} with a "sample" marker
//   [[hash:0x...]]    a hash chip with a middle ellipsis, full value on hover or tap
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { csp } from './csp.mjs';
import { config, chainValue, deployedSlotNames } from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.env.SITE_SRC ?? join(here, 'src');
const out = process.env.SITE_OUT ?? join(here, 'dist');
const layout = readFileSync(join(src, 'layout.html'), 'utf8');
// Joshua owns this domain (OPEN-QUESTIONS). The site is served by GitHub Pages at https://attessa.xyz.
const SITE_ORIGIN_HOST = 'attessa.xyz';
const phDir = join(here, 'node_modules', '@phosphor-icons', 'core', 'assets', 'regular');

const walk = dir => readdirSync(dir).flatMap(name => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.html') ? [p] : [];
});

const f = n => n.toFixed(2);

// Angles in degrees, 0 at twelve o'clock, clockwise.
function arc(cx, cy, r, a0, a1) {
  const pt = a => [cx + r * Math.sin(a * Math.PI / 180), cy - r * Math.cos(a * Math.PI / 180)];
  const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
  return `M${f(x0)} ${f(y0)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${f(x1)} ${f(y1)}`;
}

// Interleaved sine rings around a circle: the woven band printed on cheques and certificates.
function guilloche() {
  const rings = [];
  for (let k = 0; k < 4; k++) {
    const pts = [];
    for (let i = 0; i < 360; i += 2) {
      const t = i * Math.PI / 180;
      const r = 84 + 8.5 * Math.sin(15 * t + k * Math.PI / 2);
      pts.push(`${f(100 + r * Math.sin(t))} ${f(100 - r * Math.cos(t))}`);
    }
    rings.push(`<path d="M${pts.join('L')}Z"/>`);
  }
  return rings.join('');
}

// One segment per check, in checklist order: build, sealed machine, request and answer, Celo data, payment.
// States are baked in at build time ({{seal:pass pass fail na pass}}) so the seal reads right without JS.
const SEGMENTS = 5;
const GUILLOCHE = guilloche();
function seal(states = '', mini = false) {
  const st = states.trim().split(/\s+/).filter(Boolean);
  const segs = Array.from({ length: SEGMENTS }, (_, i) =>
    `<path class="seg" data-seg="${i}"${st[i] ? ` data-state="${st[i]}"` : ''} pathLength="100" d="${arc(100, 100, 66, i * 72 + 4, (i + 1) * 72 - 4)}"/>`).join('');
  return `<svg class="seal-svg${mini ? ' is-mini' : ''}" viewBox="0 0 200 200" aria-hidden="true" focusable="false">` +
    (mini ? `<circle class="seal-rim" cx="100" cy="100" r="96"/>` :
      `<g class="seal-guilloche">${GUILLOCHE}</g><circle class="seal-rim" cx="100" cy="100" r="97"/><circle class="seal-rim" cx="100" cy="100" r="72.5"/>`) +
    `<circle class="seal-track" cx="100" cy="100" r="66"/>${segs}` +
    `<circle class="seal-inner" cx="100" cy="100" r="${mini ? 48 : 56}"/></svg>`;
}

// The proof ring: five segments, one per check, drawn in checklist order from twelve o'clock.
// {{ring:pass pass fail na pass}} bakes the states in so it reads right without JS; --i drives the draw-in stagger.
function ring(states) {
  const st = states.trim().split(/\s+/);
  const segs = st.map((s, i) =>
    `<path class="ring-seg" data-state="${s}" style="--i:${i}" pathLength="100" d="${arc(50, 50, 40, i * 72 + 6, (i + 1) * 72 - 6)}"/>`).join('');
  return `<svg class="ring" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><circle class="ring-track" cx="50" cy="50" r="40"/>${segs}</svg>`;
}

const logo = `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
  Array.from({ length: SEGMENTS }, (_, i) => `<path d="${arc(12, 12, 9, i * 72 + 8, (i + 1) * 72 - 8)}"/>`).join('') +
  `<circle cx="12" cy="12" r="3"/></svg>`;

// Icons are Phosphor (regular weight, @phosphor-icons/core, exact version in package.json), inlined as SVG so the
// pages load no icon font. The class names stay (ph, ph-<name>): site.css and the status rules key off them.
// Status icons differ in shape, not only colour.
const icons = {
  pass: 'check-circle', fail: 'x-circle', na: 'minus-circle', wait: 'circle-dashed',
  yes: 'check', no: 'minus', x: 'x', alert: 'warning', arrow: 'arrow-up-right', right: 'arrow-right',
  search: 'magnifying-glass', seal: 'seal-check', terminal: 'terminal-window', clock: 'clock',
  coins: 'coins', shield: 'shield-check', copy: 'copy', github: 'github-logo', cube: 'cube',
};
// The inner markup of one Phosphor icon (every file is `<svg ... viewBox="0 0 256 256" fill="currentColor">...</svg>`).
const phInner = name => {
  const p = join(phDir, `${name}.svg`);
  if (!existsSync(p)) throw new Error(`missing Phosphor icon ${name}: run pnpm install`);
  const m = /^<svg [^>]*viewBox="0 0 256 256"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(readFileSync(p, 'utf8'));
  if (!m) throw new Error(`unexpected Phosphor icon file ${name}.svg`);
  return m[1];
};
const phSvg = (name, inner) => `<svg class="ph ph-${name}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`;
const icon = n => {
  if (!icons[n]) throw new Error(`unknown icon ${n}`);
  return phSvg(icons[n], phInner(icons[n]));
};
// The icons scripts add at run time (motion.js's hero console), handed to the bundle as a constant.
const SCRIPT_ICONS = Object.fromEntries(['check', 'x', 'minus'].map(n => [n, phInner(n)]));

const copyIcon = icon('copy');
// Two stacked arrows: on hover the first slides out and the second slides in.
const arrow = `<span class="arrow" aria-hidden="true">${icon('arrow')}${icon('arrow')}</span>`;
// Outcome track: four check nodes joined by a line, ending in the payment result.
// {{track:pass pass fail na free}}: four states (pass, fail, na) then paid, free (not charged, confirmed on
// Celo) or stopped (nothing signed, so there is nothing for Celo to confirm).
const TRACK_LABELS = ['Build', 'Machine', 'Request', 'Celo data'];
const NODE_ICON = { pass: 'yes', fail: 'x', na: 'no' };
function track(spec) {
  const st = spec.trim().split(/\s+/);
  const nodes = st.slice(0, 4).map((s, i) =>
    `<li class="tk" data-state="${s}">${i ? '<i class="seg"></i>' : ''}<span class="nd"><i class="node">${icon(NODE_ICON[s])}</i><b>${TRACK_LABELS[i]}</b></span></li>`).join('');
  const end = st[4] === 'paid'
    ? `<li class="tk tk-end" data-state="pass"><i class="seg"></i><span class="end-pill" data-end="paid">${icon('pass')}Paid</span></li>`
    : st[4] === 'stopped'
      ? `<li class="tk tk-end" data-state="na"><i class="seg"></i><span class="end-pill" data-end="stopped">${icon('na')}Nothing signed</span></li>`
      : `<li class="tk tk-end" data-state="na"><i class="seg"></i><span class="end-pill" data-end="free">${icon('fail')}Not charged</span></li>`;
  return `<ol class="track" aria-hidden="true">${nodes}${end}</ol>`;
}

// A strip of bars from a seeded generator: a visual fingerprint, not a real measurement.
// With diff, a run of bars in the middle comes from another seed and is marked, to show a mismatch.
function barcode(seed, diff = false, n = 44) {
  let s = seed, d = seed * 7 + 3;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const rnd2 = () => (d = (d * 48271) % 2147483647) / 2147483647;
  return `<span class="barcode" aria-hidden="true">${Array.from({ length: n }, (_, i) => {
    const h = rnd(), off = diff && i >= 17 && i < 29;
    return `<i${off ? ' class="x"' : ''} style="--h:${(0.25 + (off ? rnd2() : h) * 0.75).toFixed(2)}"></i>`;
  }).join('')}</span>`;
}

const slotChip = name =>
  `<span class="hash is-slot" title="Sample slot: filled from Celo or the gateway when live">` +
  `<span class="hash-val">{${name}}</span><span class="sample-tag">sample</span>` +
  `<button type="button" class="hash-copy" data-copy="{${name}}" aria-label="Copy {${name}}">${copyIcon}</button></span>`;

const hashChip = full =>
  `<span class="hash" title="${full}"><button type="button" class="hash-val" data-full="${full}" aria-expanded="false">${full.slice(0, 6)}…${full.slice(-4)}</button>` +
  `<button type="button" class="hash-copy" data-copy="${full}" aria-label="Copy ${full}">${copyIcon}</button></span>`;

function expand(html, depth = 0) {
  if (depth > 3) return html;
  return html.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => {
    const p = join(src, 'partials', `${name}.html`);
    if (!existsSync(p)) throw new Error(`missing partial ${name}`);
    return expand(readFileSync(p, 'utf8'), depth + 1);
  });
}

// The footer's mainnet radio ships disabled and marked "After launch" (layout.html). Once the deploy record has an
// EnclaveRegistry for Celo mainnet the build enables it; until then it stays as written.
const MAINNET_OFF = '<input type="radio" name="network" value="mainnet" disabled> Celo mainnet <span class="muted">After launch</span>';
function enableNetworks(html) {
  if (!html.includes(MAINNET_OFF)) throw new Error('layout.html: the mainnet radio line changed');
  return config.networks.mainnet.enabled ? html.replace(MAINNET_OFF, '<input type="radio" name="network" value="mainnet"> Celo mainnet').replace('<label class="is-disabled">', '<label>') : html;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(src, 'static'), out, { recursive: true });

// Third-party code is bundled, never loaded from a CDN. motion.js gets gsap and ScrollTrigger (as the globals it
// already reads); scene.js gets three. Output replaces the copied source files.
const bundle = (entry, outfile, extra = {}) => buildSync({
  entryPoints: [entry], outfile, bundle: true, minify: true, legalComments: 'none', target: 'es2022', logLevel: 'error', ...extra,
});
bundle(join(src, 'entry', 'motion.entry.js'), join(out, 'assets', 'motion.js'), {
  format: 'iife', define: { __PH_ICONS__: JSON.stringify(SCRIPT_ICONS) }, nodePaths: [join(here, 'node_modules')],
});
bundle(join(src, 'static', 'assets', 'scene.js'), join(out, 'assets', 'scene.js'), { format: 'esm', nodePaths: [join(here, 'node_modules')] });

// The network config, from DEPLOYMENTS and networks.json (config.mjs).
writeFileSync(join(out, 'assets', 'config.js'), `// Generated by build.mjs from @attessa/core DEPLOYMENTS and networks.json. Do not edit.\nwindow.ATTESSA_CONFIG = Object.freeze(${JSON.stringify(config)});\n`);

// GitHub Pages serves this folder as is: CNAME names the domain, .nojekyll stops Jekyll processing.
writeFileSync(join(out, 'CNAME'), `${SITE_ORIGIN_HOST}\n`);
writeFileSync(join(out, '.nojekyll'), '');

const DEPLOYED_SLOTS = deployedSlotNames();

const pagesDir = join(src, 'pages');
let count = 0;
for (const file of walk(pagesDir)) {
  const rel = relative(pagesDir, file);
  const raw = readFileSync(file, 'utf8');
  const meta = Object.fromEntries([...raw.matchAll(/^<!--\s*(\w+):\s*(.*?)\s*-->\s*$/gm)].map(m => [m[1], m[2]]));
  const body = raw.replace(/^<!--\s*\w+:.*?-->\s*\r?\n/gm, '');
  const depth = rel.split(sep).length - 1;

  let html = enableNetworks(layout).replace('{{content}}', () => expand(body));
  html = html
    .replace(/\{\{cur:(\w+)\}\}/g, (_, k) => (k === meta.nav ? ' aria-current="page"' : ''))
    .replace(/\{\{doc:(\w+)\}\}/g, (_, k) => (k === meta.doc ? ' aria-current="page"' : ''))
    .replace(/\{\{title\}\}/g, () => meta.title ?? 'Attessa')
    .replace(/\{\{description\}\}/g, () => meta.description ?? '')
    .replace(/\{\{bodyClass\}\}/g, () => meta.body ?? '')
    .replace(/\{\{seal(?::([a-z ]+))?\}\}/g, (_, st) => seal(st))
    .replace(/\{\{sealMini:([a-z ]+)\}\}/g, (_, st) => seal(st, true))
    .replace(/\{\{ring:([a-z ]+)\}\}/g, (_, st) => ring(st))
    .replace(/\{\{logo\}\}/g, () => logo)
    .replace(/\{\{copyIcon\}\}/g, () => copyIcon)
    .replace(/\{\{i:(\w+)\}\}/g, (_, n) => icon(n))
    .replace(/\{\{arrow\}\}/g, () => arrow)
    .replace(/\{\{track:([a-z ]+)\}\}/g, (_, s) => track(s))
    .replace(/\{\{barcode:(\d+)\}\}/g, (_, n) => barcode(Number(n)))
    .replace(/\{\{barcodediff:(\d+)\}\}/g, (_, n) => barcode(Number(n), true))
    .replace(/\[\[slot:(\w+)\]\]/g, (_, n) => {
      if (DEPLOYED_SLOTS.has(n)) throw new Error(`${rel}: [[slot:${n}]] is a sample slot, but the deploy record has a value for it: use [[chain:<network>.${n}]]`);
      return slotChip(n);
    })
    .replace(/\[\[chain:([\w.-]+)\]\]/g, (_, r) => hashChip(chainValue(r)))
    .replace(/\{\{chain:([\w.-]+)\}\}/g, (_, r) => chainValue(r))
    .replace(/\[\[hash:(0x[0-9a-fA-F]+)\]\]/g, (_, h) => hashChip(h))
    .replace(/\{\{root\}\}/g, () => (depth ? '../'.repeat(depth) : ''));

  html = html.replace('{{csp}}', () => csp(html));

  const leftover = html.match(/\{\{[^}]*\}\}|\[\[[^\]]*\]\]/);
  if (leftover) throw new Error(`${rel}: unexpanded ${leftover[0]}`);
  if (/—/.test(html)) throw new Error(`${rel}: contains an em dash`);

  const dest = join(out, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, html);
  count++;
}
console.log(`built ${count} pages into ${relative(here, out) || '.'}`);
