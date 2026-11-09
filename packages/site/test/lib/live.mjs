// Shared by the explorer-live-*.test.mjs files: loads assets/explorer.js without a browser, replays recorded
// JSON-RPC answers through a stand-in fetch, and gives the renderer a minimal DOM that refuses innerHTML.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { applyStatus, readLive } from '../../status.mjs';
import { config } from '../../config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const src = process.env.SITE_SRC ?? join(here, '..', '..', 'src');
export const fixtureDir = join(here, '..', 'fixtures');
// The script as the build ships it: status blocks resolved for the committed switch and deploy record.
const siteConfig = JSON.parse(readFileSync(join(here, '..', '..', 'site.config.json'), 'utf8'));
export const explorerJs = applyStatus(readFileSync(join(src, 'static', 'assets', 'explorer.js'), 'utf8'), readLive(siteConfig, { mainnet: config.networks.mainnet.enabled }));

// explorer.js is a classic script that sets window.AttessaLive (globalThis without a window).
export function loadLive() {
  const sandbox = { AbortController, setTimeout, clearTimeout, console };
  vm.createContext(sandbox);
  vm.runInContext(explorerJs, sandbox, { filename: 'explorer.js' });
  return sandbox.AttessaLive;
}

export const fixturePath = name => join(fixtureDir, `sepolia-${name}.json`);
export function fixture(name) {
  const p = fixturePath(name);
  if (!existsSync(p)) throw new Error(`missing ${p}: run node packages/site/test/fixtures/capture.mjs (read-only Celo Sepolia RPC calls) to record it`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A fetch that answers each JSON-RPC request with the recorded answer to the same method and params.
// Only the envelope's id is set to the request's id; the recorded result or error is passed through as is.
export function replay(calls, { log = [] } = {}) {
  return async (url, init) => {
    const req = JSON.parse(init.body);
    log.push({ url, method: req.method, params: req.params, init });
    const hit = calls.find(c => c.request.method === req.method && same(c.request.params, req.params));
    if (!hit) throw new Error(`no recorded answer for ${req.method} ${JSON.stringify(req.params)}`);
    const body = { ...hit.response, id: req.id };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
}

// A stand-in fetch built from a function (req) => body | Response-like | throw. For hand-written,
// labelled malformed or transport cases only.
export function scripted(fn, { log = [] } = {}) {
  return async (url, init) => {
    const req = JSON.parse(init.body);
    log.push({ url, method: req.method, params: req.params, init });
    const out = await fn(req, init);
    if (out && out.__response) return out.__response;
    return { ok: true, status: 200, json: async () => structuredClone(out) };
  };
}

// ---- Minimal DOM ----
class Text {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parent = null; }
  get textContent() { return this.data; }
}
class El {
  constructor(doc, tag, ns = null) { this.doc = doc; this.nodeType = 1; this.tagName = tag; this.ns = ns; this.attrs = new Map(); this.children = []; this.parent = null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  append(...kids) {
    for (const k of kids) {
      const n = typeof k === 'string' ? new Text(k) : k;
      if (!(n instanceof Text || n instanceof El)) throw new Error(`append of a non-node: ${typeof k}`);
      n.parent = this; this.children.push(n);
    }
  }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  get textContent() { return this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.children = [new Text(v)]; }
  set innerHTML(v) { this.doc.htmlWrites.push(v); throw new Error('innerHTML is not allowed in explorer.js'); }
  get innerHTML() { throw new Error('innerHTML read'); }
  set outerHTML(v) { throw new Error('outerHTML is not allowed'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML is not allowed'); }
  focus() { this.doc.activeElement = this; }
  all(pred = () => true) { return this.children.filter(c => c instanceof El).flatMap(c => [...(pred(c) ? [c] : []), ...c.all(pred)]); }
  find(pred) { return this.all(pred)[0] ?? null; }
  textNodes() { return this.children.flatMap(c => (c instanceof Text ? [c] : c.textNodes())); }
}
export function fakeDocument() {
  const doc = { htmlWrites: [], activeElement: null };
  doc.createElement = tag => new El(doc, tag);
  doc.createElementNS = (ns, tag) => new El(doc, tag, ns);
  doc.createTextNode = t => new Text(t);
  return doc;
}
// Text as read: elements are separated by a space, except inline values (chips, code, links, sr-only text).
const INLINE = e => ['code', 'a'].includes(e.tagName) || /\b(hash|sr-only)\b/.test(e.getAttribute('class') ?? '');
const flat = el => el.children.map(c => (c instanceof Text ? c.data : INLINE(c) ? c.textContent : ` ${flat(c)} `)).join('');
export const words = el => flat(el).replace(/\s+/g, ' ').trim();

// The ui object site.js passes, with the settled sample's real rows and verdict taken from site.js itself.
export function siteParts() {
  const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8');
  const m = js.match(/(const chip = name =>[\s\S]*?\n {2}const STATES = \{[\s\S]*?\n {2}\};)/);
  if (!m) throw new Error('precondition: site.js STATES moved');
  return vm.runInNewContext(`${m[1]}\n({ NAMES, STATES });`, { copySvg: '' });
}
export function makeUi(overrides = {}) {
  const doc = fakeDocument();
  const { NAMES, STATES } = siteParts();
  const said = [], verdicts = [];
  const ui = {
    doc, result: doc.createElement('div'), focus: true, network: 'sepolia',
    names: NAMES, rows: STATES.settled.rows.slice(0, 4), settled: STATES.settled,
    announce: m => said.push(m), setVerdict: v => verdicts.push(v),
    ...overrides,
  };
  return { ui, doc, said, verdicts };
}
