// Rehearsal-only preload (node --import): sends requests for the registered https origin to a local plain-HTTP gateway,
// so the real CLI/SDK can run against the production-style registry (allowLocalOrigins=false, https origin) with no DNS or TLS.
// Maps ONLY REHEARSE_ORIGIN_HOST -> REHEARSE_ORIGIN_TARGET (a 127.0.0.1 URL); it refuses any other target.
const host = process.env.REHEARSE_ORIGIN_HOST, target = process.env.REHEARSE_ORIGIN_TARGET;
if (host && target) {
  const t = new URL(target);
  if (t.hostname !== '127.0.0.1') throw new Error('origin-map: target must be 127.0.0.1');
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (u.hostname === host) {
      const n = new URL(u.pathname + u.search, t);
      if (typeof input === 'object' && !(input instanceof URL)) return real(new Request(n, input), init);
      return real(n, init);
    }
    return real(input, init);
  };
}
