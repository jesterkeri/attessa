/** Fixed-window per-key counters (SPEC §6.1 per-IP limits). In process; IPs are never persisted. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Counts one hit against `limit` per `windowS` seconds. */
  hit(key: string, limit: number, windowS: number): { ok: true } | { ok: false; retryAfter: number } {
    const t = this.now();
    if (t - this.lastSweep >= windowS) {
      for (const [k, w] of this.windows) if (t - w.start >= windowS) this.windows.delete(k);
      this.lastSweep = t;
    }
    const w = this.windows.get(key);
    if (!w || t - w.start >= windowS) {
      this.windows.set(key, { start: t, count: 1 });
      return { ok: true };
    }
    if (w.count >= limit) return { ok: false, retryAfter: Math.max(1, w.start + windowS - t) };
    w.count++;
    return { ok: true };
  }
}
