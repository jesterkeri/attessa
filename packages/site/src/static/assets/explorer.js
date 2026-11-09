// Attessa proof explorer: the live payment check. No dependencies and nothing from a CDN, so a failed GSAP
// or three.js load can't touch it. It reads public Celo data with plain JSON-RPC over fetch, treats every
// answer as untrusted (shapes and lengths checked before use) and renders with textContent only: nothing
// read from the chain is ever parsed as HTML. site.js calls AttessaLive.start() for a pasted transaction;
// the "UI preview" picker in site.js shows samples and never comes here.
(() => {
  // Everything that differs between networks is data here. Celo mainnet is added at Gate 5 with the
  // `celo` entry of packages/core/src/deployments.ts (USDC and USA₮) and the CLI's mainnet RPC
  // (packages/cli/src/context.ts DEFAULT_RPC); no code path changes.
  const NETWORKS = {
    sepolia: {
      name: 'Celo Sepolia',
      chainId: 11142220,
      // The CLI's default (packages/cli/src/context.ts DEFAULT_RPC.sepolia).
      rpc: 'https://forno.celo-sepolia.celo-testnet.org',
      // Celo's docs list Blockscout as the Celo Sepolia block explorer.
      explorer: { name: 'Blockscout', tx: 'https://celo-sepolia.blockscout.com/tx/' },
      // packages/core/src/deployments.ts `celo-sepolia` assets. It pins no USA₮ on Sepolia.
      // Symbol and decimals are pinned, not read from the token, and match its decimals() and symbol()
      // (packages/site/test/fixtures/sepolia-usdc-token.json).
      tokens: [{ address: '0x01c5c0122039549ad1493b8220cabedd739bc44e', symbol: 'USDC', decimals: 6 }],
    },
  };
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
  // AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce): EIP-3009, emitted by transferWithAuthorization.
  // SPEC.md section 6.2 V11: an x402 settlement is this event and the matching Transfer, both from the pinned token, in one transaction.
  const AUTH_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
  const TIMEOUT_MS = 10000;

  // ---- Reading Celo -------------------------------------------------------------------------------------

  const HASH = /^0x[0-9a-f]{64}$/;
  const WORD = /^0x[0-9a-f]{64}$/; // one 32-byte ABI word
  const QTY = /^0x(0|[1-9a-f][0-9a-f]{0,63})$/; // a JSON-RPC quantity: no leading zeros, at most 256 bits
  const ADDR = /^0x[0-9a-f]{40}$/;
  const isHash = v => typeof v === 'string' && HASH.test(v);
  const lower = v => (typeof v === 'string' ? v.toLowerCase() : v);

  class Stop extends Error {
    constructor(kind, extra = {}) { super(kind); this.kind = kind; Object.assign(this, extra); }
  }
  const bad = why => new Stop('badanswer', { why });

  // One JSON-RPC call. Anything but a well-formed answer to this exact request is a Stop.
  let nextId = 1;
  async function rpc(net, method, params, { fetch, signal }) {
    const id = nextId++;
    let res;
    try {
      res = await fetch(net.rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch (err) {
      if (signal?.aborted) throw signal.reason instanceof Stop ? signal.reason : new Stop('cancelled');
      throw new Stop('unreachable', { why: String(err?.message ?? err) });
    }
    if (!res || !res.ok) throw new Stop('unreachable', { why: `HTTP ${res?.status}` });
    let body;
    try { body = await res.json(); } catch (err) {
      if (signal?.aborted) throw signal.reason instanceof Stop ? signal.reason : new Stop('cancelled');
      throw bad('not JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0' || body.id !== id) throw bad('not a JSON-RPC answer to this request');
    if ('error' in body) throw new Stop('rpcerror', { why: String(body.error?.message ?? 'error') });
    if (!('result' in body)) throw bad('no result');
    return body.result;
  }

  const qty = (v, what) => {
    if (typeof v !== 'string' || !QTY.test(lower(v))) throw bad(`${what} is not a quantity`);
    return BigInt(v);
  };
  const wordToAddress = (w, what) => {
    if (typeof w !== 'string' || !WORD.test(lower(w))) throw bad(`${what} is not a 32-byte topic`);
    const x = lower(w);
    if (!/^0x0{24}/.test(x)) throw bad(`${what} is not an address`);
    return `0x${x.slice(26)}`;
  };

  // The receipt's on-chain facts, or a Stop that says why there are none. Pure: no network.
  function readReceipt(receipt, hash, net) {
    if (receipt === null) throw new Stop('notfound');
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw bad('receipt is not an object');
    if (lower(receipt.transactionHash) !== hash) throw bad('receipt is for another transaction');
    if (typeof receipt.blockHash !== 'string' || !HASH.test(lower(receipt.blockHash))) throw bad('no block hash');
    const blockNumber = qty(receipt.blockNumber, 'blockNumber');
    const status = lower(receipt.status);
    if (status !== '0x1' && status !== '0x0') throw bad('status is neither 0x1 nor 0x0');
    if (status === '0x0') throw new Stop('reverted', { blockNumber });
    if (!Array.isArray(receipt.logs)) throw bad('logs is not a list');
    const transfers = [], authorizers = [];
    for (const log of receipt.logs) {
      if (!log || typeof log !== 'object') throw bad('a log is not an object');
      if (typeof log.address !== 'string' || !ADDR.test(lower(log.address))) throw bad('a log has no address');
      const token = net.tokens.find(t => t.address === lower(log.address));
      if (!token || !Array.isArray(log.topics) || log.removed === true) continue;
      // V11 is one transaction: every log of the pinned token this check uses must name this transaction and, when it
      // says, this block. A log without them, or from elsewhere, makes the whole answer unreadable (a forged splice).
      const topic0 = lower(log.topics[0]);
      if (topic0 === AUTH_USED || topic0 === TRANSFER) {
        if (lower(log.transactionHash) !== hash) throw bad('a log is not from this transaction');
        if (log.blockHash != null && lower(log.blockHash) !== lower(receipt.blockHash)) throw bad('a log is not from this block');
      }
      if (topic0 === AUTH_USED) {
        // Only the pinned token's own event counts, and only with its two indexed fields (authorizer, nonce).
        if (log.topics.length === 3) authorizers.push({ token, authorizer: wordToAddress(log.topics[1], 'authorizer') });
        continue;
      }
      if (lower(log.topics[0]) !== TRANSFER) continue;
      if (log.topics.length !== 3) throw bad('a Transfer log has the wrong topics');
      if (typeof log.data !== 'string' || !WORD.test(lower(log.data))) throw bad('a Transfer amount is not one word');
      transfers.push({
        token,
        payer: wordToAddress(log.topics[1], 'from'),
        payTo: wordToAddress(log.topics[2], 'to'),
        amount: BigInt(log.data),
      });
    }
    if (transfers.length === 0) throw new Stop('notransfer', { blockNumber });
    if (transfers.length > 1) throw new Stop('multiple', { blockNumber, count: transfers.length });
    const t = transfers[0];
    // x402 only when this token's AuthorizationUsed names the address the Transfer came from (V11).
    const x402 = authorizers.some(a => a.token === t.token && a.authorizer === t.payer);
    return { ...t, x402, blockNumber, blockHash: lower(receipt.blockHash) };
  }

  function readBlock(block, paid) {
    if (block === null) throw bad('the block is missing');
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw bad('block is not an object');
    if (lower(block.hash) !== paid.blockHash) throw bad('the block is not the receipt\'s block');
    if (qty(block.number, 'block number') !== paid.blockNumber) throw bad('the block number differs');
    const ts = qty(block.timestamp, 'timestamp');
    if (ts > 8640000000000n) throw bad('timestamp out of range');
    return new Date(Number(ts) * 1000);
  }

  // The whole check for one transaction. Resolves to { kind: 'settled', ... } or { kind: <why not>, ... };
  // it never throws and never invents a value.
  async function check(hash, networkKey, { fetch = globalThis.fetch?.bind(globalThis), timeoutMs = TIMEOUT_MS, signal: outer } = {}) {
    const net = NETWORKS[networkKey];
    if (!net) return { kind: 'unsupported' };
    hash = lower(hash);
    if (!isHash(hash)) return { kind: 'malformed', net };
    if (typeof fetch !== 'function') return { kind: 'unreachable', net, why: 'no fetch' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Stop('timeout')), timeoutMs);
    const onOuter = () => ctl.abort(new Stop('cancelled'));
    if (outer) { if (outer.aborted) onOuter(); else outer.addEventListener('abort', onOuter, { once: true }); }
    const call = (m, p) => rpc(net, m, p, { fetch, signal: ctl.signal });
    // A fetch that ignores the abort signal still loses the race against the timeout.
    const raced = p => Promise.race([p, new Promise((_, no) => {
      if (ctl.signal.aborted) no(ctl.signal.reason);
      ctl.signal.addEventListener('abort', () => no(ctl.signal.reason), { once: true });
    })]);
    try {
      const [chainId, receipt] = await raced(Promise.all([call('eth_chainId', []), call('eth_getTransactionReceipt', [hash])]));
      const got = qty(chainId, 'chain id');
      if (got !== BigInt(net.chainId)) return { kind: 'wrongchain', net, hash, got: got.toString() };
      const paid = readReceipt(receipt, hash, net);
      // A Transfer without the authorization event is a plain transfer: shown as that, never as a settlement.
      if (!paid.x402) return { kind: 'plaintransfer', net, hash, ...paid };
      const block = await raced(call('eth_getBlockByNumber', [`0x${paid.blockNumber.toString(16)}`, false]));
      const time = readBlock(block, paid);
      return { kind: 'settled', net, hash, ...paid, time };
    } catch (err) {
      const stop = err instanceof Stop ? err : ctl.signal.reason instanceof Stop ? ctl.signal.reason : bad(String(err?.message ?? err));
      const { kind, ...rest } = stop;
      delete rest.message;
      return { kind, net, hash, ...rest };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  }

  // 1234500n with 6 decimals -> "1.2345"
  function formatAmount(raw, decimals) {
    const s = raw.toString().padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const frac = s.slice(s.length - decimals).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  }
  const formatTime = d => `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  const hostOf = url => url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  // ---- Rendering --------------------------------------------------------------------------------------
  // DOM nodes and textContent only. The icons are site.js's ICON shapes, drawn with createElementNS.

  const SVG = 'http://www.w3.org/2000/svg';
  const ICON = {
    pass: [['circle', { cx: 8, cy: 8, r: 6.5 }], ['path', { d: 'M5 8.3l2 2 4-4.5' }]],
    fail: [['path', { d: 'M8 1.3L14.7 8 8 14.7 1.3 8z' }], ['path', { d: 'M6 6l4 4M10 6l-4 4' }]],
    na: [['circle', { cx: 8, cy: 8, r: 6.5, 'stroke-dasharray': '2.4 2.2' }], ['path', { d: 'M5.5 8h5' }]],
    wait: [['circle', { cx: 8, cy: 8, r: 6.5 }], ['path', { d: 'M8 4.6V8l2.4 1.5' }]],
    alert: [['path', { d: 'M8 1.8l6.6 11.6H1.4z' }], ['path', { d: 'M8 6.2v3.4M8 11.6v.1' }]],
    search: [['circle', { cx: 7, cy: 7, r: 4.5 }], ['path', { d: 'M10.4 10.4L14 14' }]],
    plug: [['path', { d: 'M5.5 2v3M10.5 2v3M4 5h8v2.5a4 4 0 0 1-8 0zM8 11.5V14' }]],
    copy: [['rect', { x: 5, y: 5, width: 8.5, height: 8.5, rx: 1.5 }], ['path', { d: 'M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5' }]],
  };

  function makeRenderer(doc) {
    const h = (tag, attrs, ...kids) => {
      const el = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
      for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
      return el;
    };
    const icon = name => {
      const svg = doc.createElementNS(SVG, 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      for (const [tag, attrs] of ICON[name]) {
        const s = doc.createElementNS(SVG, tag);
        for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, String(v));
        svg.append(s);
      }
      return svg;
    };
    // The same chip markup as site.js hashChip(): site.js's click handler expands and copies it.
    const chip = full => h('span', { class: 'hash', title: full },
      h('button', { type: 'button', class: 'hash-val', 'data-full': full, 'aria-expanded': 'false' }, `${full.slice(0, 6)}…${full.slice(-4)}`),
      h('button', { type: 'button', class: 'hash-copy', 'data-copy': full, 'aria-label': `Copy ${full}` }, icon('copy')));
    const txLink = o => h('a', { class: 'bracket-link', href: `${o.net.explorer.tx}${o.hash}`, target: '_blank', rel: 'noopener noreferrer' },
      `See it on ${o.net.explorer.name}`, h('span', { class: 'sr-only' }, ' (opens in a new tab)'));
    const heading = text => h('h2', { tabindex: '-1', 'data-result-heading': '' }, text);
    return { h, icon, chip, txLink, heading };
  }

  const tokenNames = net => net.tokens.map(t => t.symbol).join(' or ');

  // What each outcome says. Wording reused from the preview states where it fits; the rest is listed in
  // OPEN-QUESTIONS.md ("not in FLOWS, pending design approval").
  function messageFor(o, r) {
    const { h, chip, txLink } = r;
    const name = o.net?.name ?? 'this network';
    const host = o.net ? h('code', null, hostOf(o.net.rpc)) : null;
    const retry = h('p', null, h('button', { type: 'button', class: 'bracket-link', 'data-retry': '' }, 'Retry'));
    switch (o.kind) {
      case 'notfound': return { tone: 'na', icon: 'search', title: 'No call found', body: [
        h('p', null, `Nothing on ${name} matches `, chip(o.hash), '.'),
        h('p', { class: 'muted' }, 'If the call was made in the last few seconds, its transaction may not be in a block yet. Check that the network in the footer is the one the call used.')] };
      case 'reverted': return { tone: 'fail', icon: 'alert', title: 'This transaction failed', body: [
        h('p', null, chip(o.hash), ` is in block ${o.blockNumber} on ${name}, but it reverted, so it moved no money and isn't a settlement.`),
        h('p', null, txLink(o))] };
      case 'notransfer': return { tone: 'na', icon: 'search', title: 'No payment in this transaction', body: [
        h('p', null, chip(o.hash), ` is in block ${o.blockNumber} on ${name}, but it moves no ${tokenNames(o.net)}, the money Attessa settles in on this network, so it isn't a settlement.`),
        h('p', null, txLink(o))] };
      case 'plaintransfer': return { tone: 'na', icon: 'search', title: 'A plain USDC transfer, not an x402 settlement', body: [
        h('p', null, chip(o.hash), ` is in block ${o.blockNumber} on ${name}. `, chip(o.payer), ` sent ${formatAmount(o.amount, o.token.decimals)} ${o.token.symbol} to `, chip(o.payTo), ', but the transaction has no x402 authorization (the token\'s AuthorizationUsed event), so nothing shows it paid for an Attessa call.'),
        h('p', { class: 'muted' }, 'An x402 settlement is that authorization and the matching transfer in one transaction. No link to an Attessa call is shown here.'),
        h('p', null, txLink(o))] };
      case 'multiple': return { tone: 'fail', icon: 'alert', title: 'More than one payment in this transaction', body: [
        h('p', null, chip(o.hash), ` moves ${tokenNames(o.net)} ${o.count} times, in block ${o.blockNumber} on ${name}. A settlement moves it once, so the explorer doesn't pick one and shows none of them.`),
        h('p', null, txLink(o))] };
      case 'wrongchain': return { tone: 'fail', icon: 'plug', title: 'Connected to the wrong network', body: [
        h('p', null, 'The explorer\'s connection to the network (', host, `) answered as chain ${o.got}, not ${name} (chain ${o.net.chainId}), so nothing was checked.`)] };
      case 'timeout': return { tone: 'wait', icon: 'plug', title: "Can't reach Celo right now", body: [
        h('p', null, `The explorer couldn't read ${name} from its connection to the network (`, host, '). Nothing was checked, and nothing about the call itself has changed. Try again in a moment.'),
        h('p', { class: 'muted' }, `It didn't answer within ${TIMEOUT_MS / 1000} seconds.`), retry] };
      case 'unreachable': case 'rpcerror': return { tone: 'wait', icon: 'plug', title: "Can't reach Celo right now", body: [
        h('p', null, `The explorer couldn't read ${name} from its connection to the network (`, host, '). Nothing was checked, and nothing about the call itself has changed. Try again in a moment.'), retry] };
      case 'malformed': return { tone: 'fail', icon: 'alert', title: "That isn't a transaction hash", body: [
        h('p', null, 'A settlement transaction starts with ', h('code', null, '0x'), ' and has 64 hex characters after it (0 to 9, a to f).')] };
      case 'unsupported': return { tone: 'na', icon: 'plug', title: 'Not on this network yet', body: [
        h('p', null, 'The live check reads Celo Sepolia only.{{#notlive mainnet}} Celo mainnet comes after launch.{{/notlive}}')] };
      default: return { tone: 'wait', icon: 'alert', title: "Can't read Celo's answer", body: [
        h('p', null, 'The explorer\'s connection to the network (', host, ') sent an answer it couldn\'t read, so nothing was checked. Try again in a moment.'), retry] };
    }
  }

  // ui (from site.js): result, names (the five check names), rows (the settled sample's first four rows,
  // all "Planned"), settled ({ word, verdict, verdictLine }), announce, setVerdict, focus.
  function plannedRows(ui, r) {
    return ui.rows.map((row, i) => r.h('li', { class: 'check', 'data-status': 'na' },
      r.h('span', { class: 'status', 'data-status': 'na' }, r.icon('na'), row.w || 'Planned'),
      r.h('div', null, r.h('p', { class: 'check-name' }, ui.names[i]), r.h('p', { class: 'check-line' }, String(row.line)))));
  }
  const meta = (r, o, extra) => r.h('p', { class: 'proof-meta' },
    r.h('span', null, 'Settlement tx ', r.chip(o.hash)), r.h('span', null, `on ${o.net.name}`), extra);

  function renderLoading(ui, r, o) {
    const heading = r.heading('Checking the payment on Celo');
    ui.result.setAttribute('aria-busy', 'true');
    ui.result.replaceChildren(r.h('div', { class: 'proof' },
      r.h('div', { class: 'proof-head' }, heading, meta(r, o)),
      r.h('ol', { class: 'checklist' }, plannedRows(ui, r),
        r.h('li', { class: 'check', 'data-status': 'wait' },
          r.h('span', { class: 'status', 'data-status': 'wait' }, r.icon('wait'), 'Checking'),
          r.h('div', null, r.h('p', { class: 'check-name' }, ui.names[4]),
            r.h('p', { class: 'check-line muted' }, `Reading this transaction from ${o.net.name}.`))))));
    ui.setVerdict('wait');
    ui.announce('Checking the payment on Celo');
    return heading;
  }

  function renderSettled(ui, r, o, readAt) {
    const s = ui.settled;
    const amount = `${formatAmount(o.amount, o.token.decimals)} ${o.token.symbol}`;
    const badge = () => r.h('span', { class: 'badge', 'data-verdict': s.verdict }, r.icon('pass'), s.word);
    const heading = r.heading('Checklist');
    ui.result.replaceChildren(r.h('div', { class: 'proof', 'data-live': '' },
      r.h('div', { class: 'proof-head' }, heading, meta(r, o, [r.h('span', null, `read from Celo at ${formatTime(readAt).slice(11)}`), badge()])),
      r.h('ol', { class: 'checklist' }, plannedRows(ui, r),
        r.h('li', { class: 'check', 'data-status': 'pass' },
          r.h('span', { class: 'status', 'data-status': 'pass' }, r.icon('pass'), 'Paid'),
          r.h('div', null,
            r.h('p', { class: 'check-name' }, ui.names[4]),
            r.h('p', { class: 'check-line' }, r.chip(o.payer), ` paid ${amount} to `, r.chip(o.payTo), ` at block ${o.blockNumber}.`),
            r.h('p', { class: 'check-term' }, `block time ${formatTime(o.time)}, ${o.token.symbol} contract `, r.chip(o.token.address)),
            r.h('p', { class: 'check-term' }, 'An x402 payment settled on Celo: the token\'s authorization and the matching transfer are in this transaction. No link to an Attessa call is shown: that needs the call\'s proof, which nothing serves yet.'),
            r.h('p', { class: 'check-links' }, r.txLink(o)))),
        r.h('li', { class: 'check is-verdict', 'data-status': s.verdict }, badge(),
          r.h('div', null, r.h('p', { class: 'check-name' }, 'Overall verdict'), r.h('p', { class: 'check-line' }, s.verdictLine))))));
    ui.setVerdict(s.verdict);
    ui.announce(`${s.word}. ${amount} paid at block ${o.blockNumber}.`);
    return heading;
  }

  function renderMessage(ui, r, o) {
    const m = messageFor(o, r);
    const heading = r.heading(m.title);
    const box = r.h('div', { class: 'state-msg', 'data-tone': m.tone }, r.icon(m.icon), r.h('div', null, heading, m.body));
    ui.result.replaceChildren(box);
    ui.setVerdict('idle');
    ui.announce(m.title);
    return heading;
  }

  function render(ui, o, { readAt = new Date() } = {}) {
    const r = makeRenderer(ui.doc ?? document);
    ui.result.removeAttribute('aria-busy');
    const heading = o.kind === 'settled' ? renderSettled(ui, r, o, readAt) : renderMessage(ui, r, o);
    if (ui.focus) heading.focus();
    return heading;
  }

  // One check at a time: a new start() or cancel() aborts the one before, and a late answer is dropped.
  let current = null;
  function cancel() { current?.abort(); current = null; }
  async function start(hash, ui) {
    cancel();
    const ctl = new AbortController();
    current = ctl;
    const net = NETWORKS[ui.network];
    const r = makeRenderer(ui.doc ?? document);
    if (net && isHash(lower(hash))) renderLoading(ui, r, { net, hash: lower(hash) });
    const o = await check(hash, ui.network, { fetch: ui.fetch, timeoutMs: ui.timeoutMs, signal: ctl.signal });
    if (ctl.signal.aborted || o.kind === 'cancelled') return o;
    current = null;
    render(ui, o);
    return o;
  }

  const api = { NETWORKS, TRANSFER, TIMEOUT_MS, check, readReceipt, readBlock, formatAmount, formatTime, messageFor, makeRenderer, render, start, cancel };
  (typeof window !== 'undefined' ? window : globalThis).AttessaLive = Object.freeze(api);
})();
