// Attessa site behaviour. No dependencies. Everything degrades to readable static HTML without it.
(() => {
  const root = document.documentElement;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };
  const announce = msg => {
    const el = $('[data-announce]');
    if (!el) return;
    el.textContent = '';
    setTimeout(() => { el.textContent = msg; }, 30);
  };

  // Network switch
  const NETWORKS = { sepolia: 'Celo Sepolia', mainnet: 'Celo mainnet' };
  const networkName = () => NETWORKS[root.dataset.network === 'mainnet' ? 'mainnet' : 'sepolia'];
  const applyNetwork = n => {
    if (n === 'mainnet') root.dataset.network = 'mainnet'; else delete root.dataset.network;
    $$('[data-network-label], [data-network-name]').forEach(el => { el.textContent = networkName(); });
    $$('input[name="network"]').forEach(r => { r.checked = r.value === (n === 'mainnet' ? 'mainnet' : 'sepolia'); });
  };
  applyNetwork(root.dataset.network);
  $$('input[name="network"]').forEach(r => r.addEventListener('change', () => {
    applyNetwork(r.value);
    store.set('attessa-network', r.value === 'mainnet' ? 'mainnet' : null);
    announce(`Network: ${networkName()}`);
  }));

  // Full-screen menu on small screens. The nav pill stays above it so the same button closes it.
  const menuBtn = $('.menu-btn');
  const menu = $('#menu');
  const setMenu = open => {
    if (!menuBtn || !menu) return;
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    menu.hidden = !open;
    root.classList.toggle('menu-open', open);
    if (open) $('a', menu)?.focus();
  };
  menuBtn?.addEventListener('click', () => setMenu(menuBtn.getAttribute('aria-expanded') !== 'true'));
  menu?.addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && root.classList.contains('menu-open')) { setMenu(false); menuBtn.focus(); }
  });
  // Same breakpoint as site.css, where the menu button shows at max-width 1020px.
  matchMedia('(min-width: 1021px)').addEventListener('change', e => { if (e.matches) setMenu(false); });

  // Entrances: elements fade up once as they enter the viewport.
  const reveals = $$('.reveal');
  if (reveals.length && 'IntersectionObserver' in window && !document.body.classList.contains('flat')) {
    const io = new IntersectionObserver(entries => entries.forEach(en => {
      if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
    }), { rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(el => io.observe(el));
  } else {
    reveals.forEach(el => el.classList.add('is-in'));
  }

  // Copy and hash expansion
  const copyText = async text => {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    }
  };
  const flash = (btn, label) => {
    btn.classList.add('is-done');
    const text = btn.querySelector('[data-copy-label]');
    if (text) text.textContent = 'Copied';
    announce(label);
    setTimeout(() => { btn.classList.remove('is-done'); if (text) text.textContent = 'Copy'; }, 1600);
  };
  document.addEventListener('click', async e => {
    const chipCopy = e.target.closest('.hash-copy');
    if (chipCopy) { if (await copyText(chipCopy.dataset.copy)) flash(chipCopy, `Copied ${chipCopy.dataset.copy}`); return; }

    const blockCopy = e.target.closest('.copy-btn');
    if (blockCopy?.dataset.copy) { if (await copyText(blockCopy.dataset.copy)) flash(blockCopy, 'Copied to clipboard'); return; }
    if (blockCopy) {
      const fig = blockCopy.closest('.code');
      const raw = $('pre', fig).innerText.replace(/\n$/, '');
      const text = fig.dataset.copy === 'commands'
        ? raw.split('\n').filter(l => l.startsWith('$ ')).map(l => l.slice(2)).join('\n')
        : raw;
      if (await copyText(text)) flash(blockCopy, 'Copied to clipboard');
      return;
    }

    const val = e.target.closest('.hash-val[data-full]');
    if (val) {
      const open = val.getAttribute('aria-expanded') !== 'true';
      const full = val.dataset.full;
      val.textContent = open ? full : `${full.slice(0, 6)}…${full.slice(-4)}`;
      val.setAttribute('aria-expanded', String(open));
    }
  });

  // Tabs
  $$('[role="tablist"]').forEach(list => {
    const tabs = $$('[role="tab"]', list);
    const select = tab => {
      tabs.forEach(t => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(t));
      t.addEventListener('keydown', e => {
        const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (e.key === 'Home' || e.key === 'End' || d) {
          e.preventDefault();
          const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : tabs[(i + d + tabs.length) % tabs.length];
          select(next); next.focus();
        }
      });
    });
    select(tabs.find(t => t.getAttribute('aria-selected') === 'true') ?? tabs[0]);
  });

  // Header index links: one picks a side on How it works, another jumps to one beat of a pinned scene.
  $$('[data-view]').forEach(a => a.addEventListener('click', () => document.getElementById(a.dataset.view)?.click()));
  $$('[data-beat-jump]').forEach(a => a.addEventListener('click', e => {
    const sec = $(a.getAttribute('href'));
    const beats = sec ? $$('[data-beat]', sec) : [];
    const i = Number(a.dataset.beatJump);
    if (!beats[i]) return;
    e.preventDefault();
    const sticky = $('.scene-sticky', sec);
    const pinned = sticky && getComputedStyle(sticky).position === 'sticky';
    const top = pinned
      ? sec.getBoundingClientRect().top + scrollY + (sec.offsetHeight - innerHeight) * (i + 0.5) / beats.length
      : beats[i].getBoundingClientRect().top + scrollY - 120;
    scrollTo({ top, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }));

  // Walkthrough (How it works): the step nearest the middle of the screen is lit, its terminal lines type
  // in the first time it lights, and the rail beside the steps fills as you go. Only the visible list runs.
  const walks = $$('[data-walk]').map(list => {
    const steps = $$('[data-walk-step]', list);
    steps.forEach(step => $$('.ln', step).forEach((ln, i) => ln.style.setProperty('--d', `${i * 240}ms`)));
    return { list, steps, on: -1 };
  });
  if (walks.length) {
    let queued = false;
    const update = () => {
      queued = false;
      const mid = innerHeight / 2;
      walks.forEach(w => {
        if (!w.list.offsetParent) return;
        let best = 0, bestD = Infinity;
        w.steps.forEach((s, i) => {
          const r = s.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - mid);
          if (d < bestD) { bestD = d; best = i; }
        });
        if (best !== w.on) {
          w.steps.forEach((s, i) => s.classList.toggle('is-on', i === best));
          w.steps[best].classList.add('is-seen');
          w.on = best;
        }
        const first = w.steps[0].getBoundingClientRect(), last = w.steps.at(-1).getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (mid - first.top) / Math.max(1, last.top + last.height / 2 - first.top)));
        w.list.style.setProperty('--p', p.toFixed(3));
      });
    };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
    addEventListener('scroll', queue, { passive: true });
    addEventListener('resize', queue);
    ['click', 'keyup'].forEach(type => document.addEventListener(type, e => { if (e.target.closest?.('[role="tab"]')) queue(); }));
    update();
  }

  // Seal
  const ICON = {
    pass: '<circle cx="8" cy="8" r="6.5"/><path d="M5 8.3l2 2 4-4.5"/>',
    fail: '<path d="M8 1.3L14.7 8 8 14.7 1.3 8z"/><path d="M6 6l4 4M10 6l-4 4"/>',
    na: '<circle cx="8" cy="8" r="6.5" stroke-dasharray="2.4 2.2"/><path d="M5.5 8h5"/>',
    wait: '<circle cx="8" cy="8" r="6.5"/><path d="M8 4.6V8l2.4 1.5"/>',
    alert: '<path d="M8 1.8l6.6 11.6H1.4z"/><path d="M8 6.2v3.4M8 11.6v.1"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4L14 14"/>',
    plug: '<path d="M5.5 2v3M10.5 2v3M4 5h8v2.5a4 4 0 0 1-8 0zM8 11.5V14"/>',
  };
  const icon = n => `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${ICON[n]}</svg>`;
  const copySvg = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5"/></svg>';
  const VERDICT_ICON = { verified: 'pass', settled: 'pass', rejected: 'fail', unattested: 'na', wait: 'wait', idle: 'search' };

  const paintSeal = (seal, states, verdict, word, sub = '') => {
    $$('.seg', seal).forEach((seg, i) => { seg.dataset.state = states[i] ?? 'idle'; });
    seal.dataset.verdict = verdict;
    const core = $('.seal-core', seal);
    if (core) core.innerHTML = `${icon(VERDICT_ICON[verdict] ?? 'search')}<span class="seal-word">${word}</span>${sub ? `<span class="seal-sub">${sub}</span>` : ''}`;
  };
  const fillSeal = seal => {
    if (reducedMotion.matches) return;
    seal.classList.remove('is-filling');
    void seal.getBoundingClientRect();
    seal.classList.add('is-filling');
  };
  // Static seals on content pages take their states from data-states and fill once when seen.
  $$('[data-seal][data-states]').forEach(seal => {
    paintSeal(seal, seal.dataset.states.split(' '), seal.dataset.verdict, seal.dataset.word, seal.dataset.sub);
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(en => en.isIntersecting)) { fillSeal(seal); io.disconnect(); }
    }, { threshold: 0.5 });
    io.observe(seal);
  });

  // Docs: mobile nav starts closed. The TOC and the docs menu both follow the reading position: the TOC marks
  // the section you're in, and the menu marks that section's link if it has one, else the page's own link.
  const docsNav = $('.docs-nav details');
  if (docsNav && matchMedia('(max-width: 760px)').matches) docsNav.open = false;
  const pathOf = u => u.pathname.replace(/\/index\.html$/, '/');
  const idOf = a => decodeURIComponent(a.hash.slice(1));
  const navAside = $('.docs-nav');
  const pageLinks = navAside ? $$('a', navAside).filter(a => pathOf(a) === pathOf(location)) : [];
  const tocLinks = $$('.toc a[href^="#"]');
  const heads = [...new Set([...tocLinks, ...pageLinks].map(idOf).filter(Boolean))]
    .map(id => document.getElementById(id)).filter(Boolean)
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  // One marker slides to the active link instead of each link lighting up on its own. It sits on the links'
  // left rule, sized to the link; the first placement is instant so it doesn't slide in from the top on load.
  const slider = (box, links, isOn) => {
    if (!box || !links.length) return () => {};
    const bar = Object.assign(document.createElement('i'), { className: 'rail-mark' });
    bar.setAttribute('aria-hidden', 'true');
    box.append(bar);
    requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('is-ready')));
    return () => {
      const a = links.find(isOn);
      if (!a || !a.offsetHeight) { bar.style.opacity = '0'; return; }
      bar.style.opacity = '1';
      bar.style.transform = `translateY(${a.offsetTop}px) scaleY(${a.offsetHeight})`;
    };
  };
  if (heads.length) {
    navAside?.classList.add('is-tracking');
    $('.toc')?.classList.add('is-tracking');
    const moveNav = slider($('.docs-nav-body'), pageLinks, a => a.classList.contains('is-here'));
    const moveToc = slider($('.toc'), tocLinks, a => a.classList.contains('is-active'));
    const navIds = new Set(pageLinks.map(idOf).filter(Boolean));
    let last = null;
    const mark = () => {
      const line = innerHeight * 0.3;
      let cur = '', navCur = '';
      for (const h of heads) {
        if (h.getBoundingClientRect().top > line) break;
        cur = h.id;
        if (navIds.has(h.id)) navCur = h.id;
      }
      if (cur + '|' + navCur === last) return;
      last = cur + '|' + navCur;
      tocLinks.forEach(a => a.classList.toggle('is-active', idOf(a) === cur));
      pageLinks.forEach(a => a.classList.toggle('is-here', navCur ? idOf(a) === navCur : !a.hash));
      moveNav(); moveToc();
    };
    let frame = 0;
    addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; mark(); }); }, { passive: true });
    addEventListener('resize', () => { moveNav(); moveToc(); });
    docsNav?.addEventListener('toggle', moveNav);
    mark();
  }

  // Proof explorer (UI preview: no chain reads yet, results use sample slots)
  const explorer = $('[data-explorer]');
  if (!explorer) return;

  const chip = name => `<span class="hash is-slot" title="Sample slot: filled from Celo or the gateway when live"><span class="hash-val">{${name}}</span><span class="sample-tag">sample</span><button type="button" class="hash-copy" data-copy="{${name}}" aria-label="Copy {${name}}">${copySvg}</button></span>`;
  const hashChip = full => `<span class="hash" title="${full}"><button type="button" class="hash-val" data-full="${full}" aria-expanded="false" aria-label="Show full value ${full}">${full.slice(0, 6)}…${full.slice(-4)}</button><button type="button" class="hash-copy" data-copy="${full}" aria-label="Copy ${full}">${copySvg}</button></span>`;
  const scan = what => `<span class="scan-slot" title="Celoscan link: fills in when live">See it on Celoscan <span class="sample-tag">${what}</span></span>`;
  const STATUS_WORD = { pass: 'Passed', fail: 'Failed', na: 'Not applicable', wait: 'Checking' };

  const NAMES = ['Approved build', 'Sealed machine', 'This exact request and answer', 'Real Celo data', 'Payment'];
  const build = { s: 'pass', line: "The agent's owner approved this build.", term: `release ${chip('releaseId')} for agent ${chip('agentId')}`, more: `Owner says it's built from ${chip('sourceRepo')} @ ${chip('sourceCommit')} <span class="muted">(not checked by Attessa)</span>`, link: scan('approval tx') };
  const machine = { s: 'pass', line: () => `AWS attests that this signer runs that build at ${chip('endpointOrigin')}.`, term: `signer ${chip('signerAddress')}, Nitro enclave, valid until ${chip('signerExpiry')}`, link: scan('signer tx') };
  const skipped = { s: 'na', w: 'Skipped', line: 'Not checked: the call stopped at the failed check.' };
  // What a settlement tx shows on Celo alone; the proof checks need the call's proof, which no public route serves yet.
  // A settlement tx names a payer, a pay-to address, an amount and a block. Many endpoints can share a pay-to
  // address, and anyone can add an endpoint with any pay-to (SPEC 3.4, L17), so the address names no endpoint.
  const buildChain = { s: 'na', w: 'Planned', line: "Planned: which endpoint and build answered needs the call's proof. A settlement names only a pay-to address, and many endpoints can share one, including ones a stranger added, so the address alone doesn't tell you." };
  const machineChain = { s: 'na', w: 'Planned', line: "Planned: which signer signed this answer needs the call's proof. The pay-to address doesn't identify it." };
  const planned = { s: 'na', w: 'Planned', line: "Planned: this check needs the call's signed proof, and no public route serves it yet." };
  const noProof = { s: 'na', line: "Once buying through buy is built (<code>attessa call --via buy</code>, optional, not built yet), the buyer's SDK would get no proof with the answer, so there is nothing to check. Celo can't show this: it has only the payment." };

  const STATES = {
    settled: {
      verdict: 'settled', word: 'Settled on Celo', sub: 'proof checks planned',
      rows: [buildChain, machineChain, planned, planned,
        { s: 'pass', w: 'Paid', line: () => `${chip('payer')} paid ${chip('amount')} ${chip('asset')} to ${chip('payTo')} at block ${chip('settlementBlock')}.`, term: `settled in tx ${chip('settlementTx')}, EIP-3009 authorization`, link: scan('settlement tx') }],
      verdictLine: "Celo shows this payment settled: who paid, to which address, how much, and in which block. That isn't a verified call, and an address alone doesn't tell which endpoint, build or signer answered. Whether the proof passed, and who answered this exact request with these inputs, needs the call's proof, and those checks are planned.",
    },
    tampered: {
      verdict: 'rejected', word: 'Rejected', sub: 'not charged', ref: 'sdk',
      rows: [build, machine,
        { s: 'fail', line: "The answer doesn't match what the sealed machine signed.", term: '<span class="t">response_hash_mismatch</span> the response hash differs from the proof' },
        skipped,
        { s: 'pass', w: 'Not charged', line: () => `Not charged: the payment permission expired unused at block ${chip('expiryBlock')}, so no money moved.`, term: `EIP-3009 authorization ${chip('authorizationNonce')}, never settled`, link: scan('block') }],
      verdictLine: 'Rejected at "This exact request and answer". Nothing was settled and the buyer was not charged.',
    },
    unapproved: {
      verdict: 'rejected', word: 'Rejected', sub: 'not charged', ref: 'sdk',
      rows: [
        { s: 'fail', line: "The agent's owner withdrew this build's approval (revoked or deprecated it) after the gateway's signer check and before its proof check.", term: `<span class="t">release_not_approved</span> release ${chip('releaseId')} for agent ${chip('agentId')}` },
        machine, skipped, skipped,
        { s: 'pass', w: 'Not charged', line: 'Not charged: Celo shows the payment permission expired unused.', term: 'no settlement for this request' }],
      verdictLine: 'Rejected at "Approved build". The approval was withdrawn on Celo between the gateway\'s signer check and its proof check, so the proof check refused the call. A build that was never approved can\'t register a signer, so a buyer stops before signing anything.',
    },
    unattested: {
      verdict: 'unattested', word: 'Unattested', sub: 'no proof', ref: 'sdkTx',
      rows: [noProof, noProof, noProof, noProof,
        { s: 'na', w: 'Unprotected', line: () => `Paid ${chip('amount')} ${chip('asset')} through buy, Celo's marketplace of pay-per-call APIs. Payment protection is none here: buy takes payment before the service runs. That holds whether or not the service offers a proof.`, term: `paid before the call (Mode A), settled in tx ${chip('settlementTx')}`, link: scan('settlement tx') }],
      verdictLine: "No proof offered: this service doesn't say which code produced its answer, so it can't be checked",
    },
  };

  const form = $('[data-explorer-form]', explorer);
  const input = $('input', form);
  const fieldError = $('[data-field-error]', explorer);
  const result = $('[data-result]', explorer);
  const preview = $('[data-preview]', explorer);
  let lastQuery = null;
  let timer = null;

  const queryChip = () => (lastQuery ? hashChip(lastQuery) : chip('settlementTx'));
  const resolve = v => (typeof v === 'function' ? v() : v);
  // The particle seal beside the result (scene.js) follows this: verified, rejected, unattested, wait or idle.
  // A settled result (Celo only, no proof) has no seal of its own, so the particles stay dust.
  const grid = $('.result-grid', explorer);
  const setVerdict = v => { if (grid) grid.dataset.verdict = v; };

  // What a result is headed by. A call that settled has a settlement tx; a call that was never settled has none,
  // so its sample is headed as what the buyer's SDK shows.
  const REF = {
    tx: () => `Settlement tx ${queryChip()}`,
    sdk: () => "Sample of what the buyer's SDK shows. No settlement tx: this call never settled",
    sdkTx: () => `<span class="muted">Optional, not built yet:</span> a sample of what the buyer's SDK would show for a purchase through buy, settlement tx ${queryChip()}`,
  };
  const head = (title, extra, ref) => `
    <div class="proof-head"><h2 tabindex="-1" data-result-heading>${title}</h2>
      <p class="proof-meta"><span>${ref}</span><span>on <span data-network-name>${networkName()}</span></span>${extra || ''}</p></div>`;

  function renderChecklist(key) {
    const st = STATES[key];
    const rows = st.rows.map((r, i) => `
      <li class="check" data-status="${r.s}">
        <span class="status" data-status="${r.s}">${icon(r.s)}${r.w || STATUS_WORD[r.s]}</span>
        <div>
          <p class="check-name">${NAMES[i]}</p>
          <p class="check-line">${resolve(r.line)}</p>
          ${r.term ? `<p class="check-term">${r.term}</p>` : ''}
          ${r.more ? `<p class="check-term">${r.more}</p>` : ''}
          ${r.link ? `<p class="check-links">${r.link}</p>` : ''}
        </div>
      </li>`).join('');
    result.innerHTML = `
      <div class="proof">
        ${head('Sample checklist', `<span class="badge" data-verdict="${st.verdict}">${icon(VERDICT_ICON[st.verdict])}${st.word}</span>`, REF[st.ref || 'tx']())}
        <ol class="checklist">${rows}
          <li class="check is-verdict" data-status="${st.verdict}">
            <span class="badge" data-verdict="${st.verdict}">${icon(VERDICT_ICON[st.verdict])}${st.word}</span>
            <div><p class="check-name">Overall verdict</p><p class="check-line">${st.verdictLine}</p></div>
          </li>
        </ol>
      </div>`;
    setVerdict(st.verdict);
    announce(`${st.word}. ${st.verdictLine}`);
  }

  function renderLoading() {
    result.setAttribute('aria-busy', 'true');
    result.innerHTML = `
      <div class="proof">
        ${head('Checking the payment on Celo', '', REF.tx())}
        <ol class="checklist">${NAMES.map((n, i) => (i === NAMES.length - 1 ? `
          <li class="check" data-status="wait"><span class="status" data-status="wait">${icon('wait')}Checking</span>
            <div><p class="check-name">${n}</p><p class="check-line muted">When live, this reads the settlement from public Celo data.</p></div></li>` : `
          <li class="check" data-status="na"><span class="status" data-status="na">${icon('na')}Planned</span>
            <div><p class="check-name">${n}</p><p class="check-line muted">${planned.line}</p></div></li>`)).join('')}
        </ol>
      </div>`;
    setVerdict('wait');
    announce('Checking the payment on Celo');
  }

  const message = (tone, ic, title, body) => {
    result.innerHTML = `<div class="state-msg" data-tone="${tone}">${icon(ic)}<div><h2 tabindex="-1" data-result-heading>${title}</h2>${body}</div></div>`;
    setVerdict('idle');
    announce(title);
  };

  const MESSAGES = {
    notfound: () => message('na', 'search', 'No call found', `
      <p>Sample state: nothing on <span data-network-name>${networkName()}</span> matches ${queryChip()}.</p>
      <p class="muted">If the call was made in the last few seconds, its transaction may not be in a block yet. Check that the network in the footer is the one the call used. Looking a call up by its request ID is planned.</p>`),
    malformed: () => message('fail', 'alert', "That isn't a transaction hash", `
      <p>A settlement transaction starts with <code>0x</code> and has 64 hex characters after it (0 to 9, a to f).</p>
      <p class="muted">It is the payment's transaction on Celoscan. Looking a call up by its request ID is planned.</p>`),
    rpc: () => message('wait', 'plug', "Can't reach Celo right now", `
      <p>The explorer couldn't read <span data-network-name>${networkName()}</span> from its connection to the network (${chip('rpcUrl')}). Nothing was checked, and nothing about the call itself has changed. Try again in a moment.</p>
      <p><button type="button" class="bracket-link" data-retry>Retry</button></p>`),
  };

  function show(key, { focus = false } = {}) {
    clearTimeout(timer);
    result.removeAttribute('aria-busy');
    if (key !== 'malformed') { input.removeAttribute('aria-invalid'); fieldError.hidden = true; }
    if (key === 'loading') renderLoading();
    else if (STATES[key]) renderChecklist(key);
    else MESSAGES[key]?.();
    if (focus) $('[data-result-heading]', result)?.focus();
  }

  function run({ focus = true } = {}) {
    show('loading');
    const outcome = preview.value;
    const target = ['loading', 'malformed'].includes(outcome) ? 'settled' : outcome;
    if (outcome === 'loading') return;
    timer = setTimeout(() => show(target, { focus }), reducedMotion.matches ? 300 : 1100);
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    const v = input.value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
      input.setAttribute('aria-invalid', 'true');
      fieldError.hidden = false;
      $('[data-field-error-text]', fieldError).textContent = v
        ? "That isn't a transaction hash. A settlement transaction is 0x followed by 64 hex characters."
        : 'Paste a settlement transaction first.';
      lastQuery = null;
      show('malformed');
      input.focus();
      return;
    }
    lastQuery = v.toLowerCase();
    run();
  });

  preview.addEventListener('change', () => show(preview.value));
  result.addEventListener('click', e => { if (e.target.closest('[data-retry]')) run(); });
  $$('[data-open-state]', explorer).forEach(btn => btn.addEventListener('click', () => {
    lastQuery = null;
    preview.value = btn.dataset.openState;
    show(btn.dataset.openState, { focus: true });
    result.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
  }));

  // Arriving from a link with ?q= (the homepage's search posts here): check that call straight away.
  const fromLink = new URLSearchParams(location.search).get('q');
  if (fromLink) { input.value = fromLink; form.requestSubmit(); }
  else show(preview.value);
})();
