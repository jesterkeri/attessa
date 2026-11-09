// T47: how much work the scene does when nothing is happening. Local headless Chromium, no network.
// Run after a build: pnpm --filter @attessa/site build && node packages/site/scripts/perf-probe.mjs
// playwright-core is not a dependency of this repo: point PLAYWRIGHT_CORE at an install (default ~/.cache/mako-shots),
// and on a machine without the browser's system libraries set LD_LIBRARY_PATH to a folder that has them.
// Scene frame = one WebGL clear (three clears once per render). It prints one line per case and exits 1 on a miss.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const core = process.env.PLAYWRIGHT_CORE ?? join(homedir(), '.cache', 'mako-shots');
const { chromium } = createRequire(join(core, 'package.json'))('playwright-core');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.json': 'application/json' };
const server = createServer((req, res) => {
  let p = join(dist, decodeURIComponent((req.url ?? '/').split('?')[0]));
  if (p.endsWith('/')) p += 'index.html';
  if (!p.startsWith(dist) || !existsSync(p)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', types[extname(p)] ?? 'application/octet-stream');
  res.end(readFileSync(p));
}).listen(0);
const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;

const counters = () => {
  const w = /** @type {any} */ (window);
  w.__raf = 0; w.__clears = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(t => { w.__raf++; cb(t); });
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    const clear = C.prototype.clear;
    C.prototype.clear = function (...a) { w.__clears++; return clear.apply(this, a); };
  }
};
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const read = page => page.evaluate(() => ({ raf: /** @type {any} */ (window).__raf, clears: /** @type {any} */ (window).__clears }));
const reset = page => page.evaluate(() => { const w = /** @type {any} */ (window); w.__raf = 0; w.__clears = 0; });
let failed = false;
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); if (!ok) failed = true; };

async function open(path, { reducedMotion = 'no-preference', saveData = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion });
  const page = await ctx.newPage();
  await page.addInitScript(counters);
  if (saveData) await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true } }));
  await page.goto(`${base}/${path}`);
  return page;
}

// 1. Idle on a page with no story: the scene stops drawing.
for (const path of ['docs/reference.html', 'index.html']) {
  const page = await open(path);
  await page.waitForTimeout(5000);
  const warm = await read(page);
  await reset(page);
  await page.waitForTimeout(2000);
  const idle = await read(page);
  check(`${path} idle 2 s`, idle.clears === 0, `${idle.clears} scene frames (${warm.clears} while loading), ${idle.raf} rAF calls`);
  await reset(page);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(600);
  const moved = await read(page);
  check(`${path} scroll wakes it`, moved.clears > 0, `${moved.clears} scene frames after a scroll`);
  await page.context().close();
}
// 2. Reduced motion: no rAF at all once the first frame is drawn, and no ScrollTrigger.
{
  const page = await open('docs/reference.html', { reducedMotion: 'reduce' });
  await page.waitForTimeout(3000);
  await reset(page);
  await page.waitForTimeout(2000);
  const idle = await read(page);
  const st = await page.evaluate(() => /** @type {any} */ (window).ScrollTrigger?.getAll?.().length ?? 0);
  check('docs/reference.html reduced motion idle 2 s', idle.raf === 0 && idle.clears === 0, `${idle.raf} rAF calls, ${idle.clears} scene frames, ${st} ScrollTriggers`);
  check('reduced motion registers no ScrollTrigger', st === 0, `${st}`);
  await page.context().close();
}
// 3. Data Saver: the scene never draws.
{
  const page = await open('index.html', { saveData: true });
  await page.waitForTimeout(3000);
  const s = await read(page);
  const noGl = await page.evaluate(() => document.documentElement.classList.contains('no-webgl'));
  check('index.html with saveData', s.clears === 0 && noGl, `${s.clears} scene frames, no-webgl class ${noGl}`);
  await page.context().close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
