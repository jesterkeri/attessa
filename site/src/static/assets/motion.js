// Site motion (homepage first, shared by the inner pages). Each effect has one job: draw the eye in order,
// explain a step, or confirm an action.
// GSAP + ScrollTrigger drive the scroll effects; the 3D scene runs separately in scene.js.
// Reduced motion: none of the movement runs, everything is shown in its final state.
(() => {
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const done = () => root.classList.remove('motion-pending');

  // Nav: the bar takes its dark backing once you scroll; a thin line glides under the hovered link.
  const nav = $('[data-nav]');
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { nav?.classList.toggle('is-scrolled', scrollY > 24); ticking = false; });
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  const links = $('[data-nav-links]');
  const ind = links && $('.nav-ind', links);
  if (ind && fine) {
    const moveTo = a => {
      ind.style.width = `${a.offsetWidth}px`;
      ind.style.transform = `translateX(${a.offsetLeft}px)`;
      ind.style.opacity = '1';
    };
    $$('a', links).forEach(a => a.addEventListener('pointerenter', () => moveTo(a)));
    links.addEventListener('pointerleave', () => { ind.style.opacity = '0'; });
  }

  // Cursor light on cards.
  if (fine) {
    $$('.card').forEach(card => card.addEventListener('pointermove', e => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    }));
  }

  // Text scramble: characters decode left to right. Used on nav hover and on mono labels as they enter.
  const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/<>#*+=';
  function scramble(el, duration = 520) {
    if (reduce) return;
    const finalText = el.dataset.text || (el.dataset.text = el.textContent);
    const start = performance.now();
    cancelAnimationFrame(el._scr);
    const step = now => {
      const p = Math.min(1, (now - start) / duration);
      const reveal = Math.floor(p * finalText.length);
      el.textContent = [...finalText].map((ch, i) => (i < reveal || ch === ' ' ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join('');
      if (p < 1) el._scr = requestAnimationFrame(step); else el.textContent = finalText;
    };
    el._scr = requestAnimationFrame(step);
  }
  if (fine) $$('.nav-links [data-scramble]').forEach(a => a.addEventListener('pointerenter', () => scramble(a, 380)));

  // Hero console: prints a call being checked line by line, alternating a clean call with a tampered one.
  const conLines = $('[data-con-lines]');
  const ICON = { pass: 'check', fail: 'x', skip: 'minus' };
  const RUNS = [
    [
      ['pass', 'approved build'], ['pass', 'sealed machine'], ['pass', 'request and answer'], ['pass', 'celo data'],
      ['verdict ok', 'verified, paid'],
    ],
    [
      ['pass', 'approved build'], ['pass', 'sealed machine'], ['fail', 'request and answer', 'response hash ≠ proof'], ['skip', 'celo data', 'skipped'],
      ['verdict bad', 'rejected, not charged'],
    ],
  ];
  const line = ([kind, text, note]) => {
    const li = document.createElement('li');
    if (kind.startsWith('verdict')) { li.className = `is-verdict ${kind.split(' ')[1]}`; li.textContent = text; return li; }
    li.className = `is-${kind}`;
    li.innerHTML = `<i class="ph ph-${ICON[kind]}" aria-hidden="true"></i><span>${text}</span>${note ? `<span class="note">(${note})</span>` : ''}`;
    return li;
  };
  const cmdLine = () => {
    const li = document.createElement('li');
    li.className = 'is-cmd';
    li.innerHTML = '<span class="p">$</span><span data-cmd></span>';
    return li;
  };
  const CMD = 'attessa call risk.example';
  if (conLines && reduce) {
    const li = cmdLine(); $('[data-cmd]', li).textContent = CMD; conLines.append(li);
    RUNS[0].forEach(l => conLines.append(line(l)));
  }
  if (conLines && !reduce) {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const cursor = Object.assign(document.createElement('span'), { className: 'cursor' });
    (async () => {
      await wait(1900);
      for (let n = 0; ; n++) {
        conLines.textContent = '';
        const cmd = cmdLine();
        conLines.append(cmd);
        const out = $('[data-cmd]', cmd);
        cmd.append(cursor);
        for (const ch of CMD) { out.textContent += ch; await wait(38); }
        await wait(380);
        for (const l of RUNS[n % RUNS.length]) {
          const li = line(l);
          conLines.append(li);
          li.append(cursor);
          await wait(l[0].startsWith('verdict') ? 0 : 420);
        }
        await wait(3400);
      }
    })();
  }

  if (reduce || !window.gsap || !window.ScrollTrigger) { done(); return; }
  gsap.registerPlugin(ScrollTrigger);
  const EASE = 'expo.out';

  // Split a heading into word masks so each word rises from behind its own edge. Line breaks stay, and
  // words inside an .ol span keep their outline.
  function split(el) {
    el.setAttribute('aria-label', el.textContent.replace(/\s+/g, ' ').trim());
    const parts = [];
    el.childNodes.forEach(n => {
      if (n.nodeName === 'BR') { parts.push('<br>'); return; }
      const ol = n.nodeType === 1 && n.classList.contains('ol');
      n.textContent.split(/\s+/).filter(Boolean).forEach(w => parts.push(`<span class="wm" aria-hidden="true"><span class="wi${ol ? ' ol' : ''}">${w}</span></span>`));
    });
    el.innerHTML = parts.join(' ').replace(/ ?<br> ?/g, '<br>');
    return $$('.wi', el);
  }

  // Hero intro: headline words rise, then the copy, buttons and proof strip come into focus.
  const heroH1 = $('.hero h1');
  const heroWords = heroH1 ? split(heroH1) : [];
  // The display face has a width axis: each word rises narrower still and widens into its condensed set width.
  // Other pages share this file, so every target is looked up first and missing ones are simply skipped.
  const heroRest = [['.hero .lede', 1, '-=0.95'], ['.hero .btn-row', 1, '-=0.8'], ['.console', 1.1, '-=0.7'], ['.page-index', 1, '-=0.85']]
    .map(([sel, duration, at]) => ({ els: $$(sel), duration, at })).filter(r => r.els.length);
  if (heroWords.length) {
    gsap.set(heroWords, { yPercent: 115, fontVariationSettings: '"wdth" 50' });
    heroRest.forEach(r => gsap.set(r.els, { autoAlpha: 0, y: 18, filter: 'blur(8px)' }));
  }
  done();
  if (heroWords.length) {
    const intro = gsap.timeline({ delay: 0.25 })
      .to(heroWords, { yPercent: 0, duration: 1.3, ease: EASE, stagger: 0.07 })
      .to(heroWords, { fontVariationSettings: '"wdth" 64', duration: 1.6, ease: 'power3.out', stagger: 0.07 }, 0.15);
    heroRest.forEach(r => intro.to(r.els, { autoAlpha: 1, y: 0, filter: 'blur(0px)', duration: r.duration, ease: EASE }, r.at));
  }

  // The hero drifts up and dims as you leave, while the dust gathers into the cubes.
  if ($('.hero-inner')) gsap.to('.hero-inner', { yPercent: -14, autoAlpha: 0.15, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });

  // Mono labels decode as they enter.
  $$('main .label[data-scramble], .statement-sec .label').forEach(el => {
    ScrollTrigger.create({ trigger: el, start: 'top 88%', once: true, onEnter: () => scramble(el) });
  });

  // Section headings: words rise out of their masks.
  $$('main h2[data-split]').forEach(h => {
    const ws = split(h);
    gsap.from(ws, { yPercent: 115, duration: 1.2, ease: EASE, stagger: 0.05, scrollTrigger: { trigger: h, start: 'top 85%' } });
  });

  // Supporting copy comes into focus: fade, rise, unblur.
  $$('[data-fade]').forEach(el => {
    gsap.from(el, { autoAlpha: 0, y: 24, filter: 'blur(10px)', duration: 1.1, ease: EASE, scrollTrigger: { trigger: el, start: 'top 88%' } });
  });

  // The outcomes, the explorer's globe and the spending limits are pinned scenes driven by scene.js.

  // Quickstart: steps step in, then the terminal types its output line by line.
  if ($('.try-steps')) gsap.from('.try-steps li', { autoAlpha: 0, x: -24, duration: 0.9, ease: EASE, stagger: 0.12, scrollTrigger: { trigger: '.try-steps', start: 'top 85%' } });
  const term = $('[data-terminal]');
  const code = term && $('pre code', term);
  if (code) {
    code.innerHTML = code.innerHTML.split('\n').map(l => `<span class="ln">${l}</span>`).join('\n');
    const lines = $$('.ln', code);
    const cursor = Object.assign(document.createElement('span'), { className: 'cursor' });
    cursor.setAttribute('aria-hidden', 'true');
    gsap.set(lines, { clipPath: 'inset(0 100% 0 0)' });
    gsap.timeline({ scrollTrigger: { trigger: term, start: 'top 70%' } })
      .from(term, { autoAlpha: 0, y: 40, filter: 'blur(10px)', duration: 1, ease: EASE })
      .to(lines[0], { clipPath: 'inset(0 0% 0 0)', duration: 1.1, ease: 'steps(48)' }, '-=0.3')
      .to(lines.slice(1), { clipPath: 'inset(0 0% 0 0)', duration: 0.5, ease: 'power2.out', stagger: 0.32 }, '+=0.25')
      .add(() => lines.at(-1).after(cursor));
  }

  // Honest limits is a pinned scene too: scene.js brings each line in as the scroll reaches it.

  // Finale heading scales into place as the mountain rises behind it.
  if ($('.cta-sec')) gsap.from('.cta-sec h2', { scale: 0.9, duration: 1.6, ease: EASE, scrollTrigger: { trigger: '.cta-sec', start: 'top 80%' } });

  addEventListener('load', () => ScrollTrigger.refresh());
})();
