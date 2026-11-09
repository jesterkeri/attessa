// Builds the static site: node build.mjs (SITE_OUT=<folder> writes somewhere other than dist/)
// Each src/pages/**.html is wrapped in src/layout.html and written to dist/ at the same path.
// Page header comments set metadata: <!-- title: ... -->, <!-- description: ... -->, <!-- nav: ... -->, <!-- doc: ... -->
// Shorthands expanded at build time:
//   {{root}}          relative path back to the site root, so pages work from file:// and any host path
//   {{seal}}          the proof seal SVG (guilloche ring + five check segments); {{seal:pass pass fail na pass}} bakes states
//   {{sealMini:...}}  the small seal for outcome rows, no guilloche
//   {{ring:...}}      the five-segment proof ring used by the dark homepage
//   {{logo}}          the Attessa logo
//   {{> name}}        src/partials/name.html
//   [[slot:name]]     a sample slot chip, shown as {name} with a "sample" marker
//   [[hash:0x...]]    a hash chip with a middle ellipsis, full value on hover or tap
//   <!--notlive:key-->..<!--/notlive-->, <!--live:key-->..<!--/live-->  the launch switch: status.mjs, site.config.json `live`
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { csp } from './csp.mjs';
import { config, chainValue, deployedSlotNames } from './config.mjs';
import { applyStatus, readLive } from './status.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.env.SITE_SRC ?? join(here, 'src');
const out = process.env.SITE_OUT ?? join(here, 'dist');
const layout = readFileSync(join(src, 'layout.html'), 'utf8');
// Joshua owns this domain (OPEN-QUESTIONS). The site is served by GitHub Pages at https://attessa.xyz.
const siteConfig = JSON.parse(readFileSync(process.env.SITE_CONFIG ?? join(here, 'site.config.json'), 'utf8'));
if (!/^https:\/\/[a-z0-9.-]+$/.test(siteConfig.siteOrigin)) throw new Error('site.config.json: siteOrigin must be https://<host> with no path');
const SITE_ORIGIN_HOST = new URL(siteConfig.siteOrigin).host;
if (process.env.SITE_TEST_DEPLOYMENTS) throw new Error('SITE_TEST_DEPLOYMENTS is not a build input: only tests use it, through test/lib/test-record.mjs. A build takes its deploy record from @attessa/core');
const live = readLive(siteConfig, { mainnet: config.networks.mainnet.enabled });
const contactSet = siteConfig.securityContact != null && siteConfig.securityTxtExpires != null;
if (contactSet) {
  if (!/^(mailto:\S+@\S+|https:\/\/\S+|tel:\S+)$/.test(siteConfig.securityContact)) throw new Error('site.config.json: securityContact must be a mailto:, https: or tel: URI');
  const t = Date.parse(siteConfig.securityTxtExpires);
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(siteConfig.securityTxtExpires) || Number.isNaN(t) || t < Date.now() || t > Date.now() + 366 * 864e5) throw new Error('site.config.json: securityTxtExpires must be an ISO date in the future, within a year (RFC 9116)');
} else if (!process.env.SITE_CONFIG) {
  // The committed config is the publishable one: no contact or expiry, no build. A local build can opt out with SITE_CONFIG=<file>.
  throw new Error('site.config.json: securityContact and securityTxtExpires are null. A production build needs both (RFC 9116); for a local build point SITE_CONFIG at a config file');
} else if ((siteConfig.securityContact == null) !== (siteConfig.securityTxtExpires == null)) {
  throw new Error('site.config.json: set securityContact and securityTxtExpires together, or neither');
}
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

// Traced from Joshua's original logo (1024 x 1024). assets/favicon.svg holds the same shape on its black ground.
const logo = `<svg class="logo" viewBox="215 215 594 594" aria-hidden="true" focusable="false">` +
  `<path fill-rule="evenodd" d="M 638.4 234.4 C 555.8 255.8, 491.3 283.7, 423.5 327.3 C 336.2 383.4, 281.9 448.0, 270.3 509.5 C 267.6 524.0, 267.8 546.3, 270.8 558.4 C 280.1 596.1, 310.9 622.6, 359.5 634.8 C 378.2 639.5, 387.1 640.5, 413 640.4 C 498.8 640.3, 580.5 604.6, 604.9 556.6 C 612.3 542.0, 609.5 524.9, 598.9 519.4 C 590.5 515.1, 584.0 519.8, 581.5 532 C 578.9 544.5, 565.0 563.7, 552.8 571.6 C 537.9 581.2, 530.0 583.5, 511 583.4 C 498.5 583.3, 495.6 583.0, 490.5 581.1 C 475.1 575.4, 477.5 575.4, 459.5 580.9 C 410.3 596.2, 358.6 587.7, 330.8 559.8 C 315.5 544.5, 308.9 528.3, 309.0 505.6 C 309.0 456.7, 343.5 403.5, 410.5 348.9 C 470.4 300.0, 555.5 258.9, 642.5 236.9 C 650.2 235.0, 653.5 233.7, 653.8 232.5 C 654.2 230.4, 653.5 230.5, 638.4 234.4 M 590.5 383.6 C 512.6 391.9, 454.5 417.5, 425.8 456.0 C 412.6 473.8, 411.1 492.9, 422.2 502.4 C 430.4 509.4, 438.4 506.5, 441.5 495.3 C 448.6 469.6, 464.8 451.9, 489.1 443.2 C 495.8 440.8, 497.9 440.6, 511.5 440.5 C 527.0 440.5, 526.8 440.4, 542 445.9 C 548.1 448.1, 548.3 448.1, 563.3 443.3 C 612.7 427.7, 664.5 435.9, 692.9 463.8 C 708.2 478.9, 715 495.5, 715 518.4 C 715 567.0, 680.1 620.8, 613.5 675.0 C 564.7 714.7, 500.1 749.1, 430.6 772.4 C 412.2 778.5, 381.0 787.6, 374.7 788.6 C 371.2 789.2, 368.9 791.2, 370.2 792.6 C 371.5 793.8, 415.7 781.7, 442 772.9 C 551.3 736.5, 655.3 670.1, 710.5 601.4 C 727.4 580.5, 741.5 555.6, 748.3 535 C 758.6 503.3, 758.1 472.0, 746.9 448.1 C 731.7 415.7, 694.0 392.3, 645 385.0 C 637.3 383.8, 597.7 382.8, 590.5 383.6"/><circle cx="512" cy="512" r="45"/></svg>`;

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

// Everything copied or bundled says the same as the pages: the same status blocks, resolved once, wherever the file sits.
const copied = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? copied(join(dir, e.name)) : [join(dir, e.name)]));
for (const file of copied(out).filter(p => /\.(js|mjs|cjs|html|css|txt|json|svg)$/.test(p))) writeFileSync(file, applyStatus(readFileSync(file, 'utf8'), live));

// security.txt: filled from site.config.json. With no contact yet it says so, in comments only (RFC 9116 needs a Contact
// and an Expires line, so it is not valid until they are set), and never carries a placeholder.
const securityTxt = contactSet
  ? `Contact: ${siteConfig.securityContact}\nExpires: ${siteConfig.securityTxtExpires.length === 10 ? `${siteConfig.securityTxtExpires}T00:00:00Z` : siteConfig.securityTxtExpires}\nPreferred-Languages: en\nCanonical: ${siteConfig.siteOrigin}/.well-known/security.txt\n`
  : `# Attessa has not published a security contact yet. This file is not a valid RFC 9116 file until it has a Contact and an Expires line.\n# Canonical: ${siteConfig.siteOrigin}/.well-known/security.txt\n`;
writeFileSync(join(out, '.well-known', 'security.txt'), securityTxt);

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

  let html = layout.replace('{{content}}', () => expand(body));
  html = html
    .replace(/\{\{cur:(\w+)\}\}/g, (_, k) => (k === meta.nav ? ' aria-current="page"' : ''))
    .replace(/\{\{doc:(\w+)\}\}/g, (_, k) => (k === meta.doc ? ' aria-current="page"' : ''))
    .replace(/\{\{title\}\}/g, () => meta.title ?? 'Attessa')
    .replace(/\{\{description\}\}/g, () => meta.description ?? '');
  html = applyStatus(html, live);
  html = html
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

  // <!--if-no-contact-->...<!--/if-no-contact--> is copy that holds only while security.txt has no contact.
  html = html.replace(/<!--if-no-contact-->([\s\S]*?)<!--\/if-no-contact-->/g, (_, inner) => (contactSet ? '' : inner));

  const leftover = html.match(/\{\{[^}]*\}\}|\[\[[^\]]*\]\]/);
  if (leftover) throw new Error(`${rel}: unexpanded ${leftover[0]}`);
  if (/—/.test(html)) throw new Error(`${rel}: contains an em dash`);

  const dest = join(out, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, html);
  count++;
}
console.log(`built ${count} pages into ${relative(here, out) || '.'}`);
