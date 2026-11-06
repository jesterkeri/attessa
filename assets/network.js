// Which network the page starts on. Pure, so a test can run it without a browser (window.AttessaNetwork.pick).
// Order: ?network=<key> in the address, then the network saved in local storage, then Celo Sepolia. A network the
// config marks disabled (Attessa's registry is not deployed there yet) is never picked, from either source.
(() => {
  const pick = (config, search, stored) => {
    const ok = k => typeof k === 'string' && Object.prototype.hasOwnProperty.call(config.networks, k) && config.networks[k].enabled === true;
    let fromUrl = null;
    try { fromUrl = new URLSearchParams(search).get('network'); } catch { /* unreadable address */ }
    if (ok(fromUrl)) return fromUrl;
    if (ok(stored)) return stored;
    return 'sepolia';
  };
  (typeof window !== 'undefined' ? window : globalThis).AttessaNetwork = Object.freeze({ pick });
})();
