// The only in-process memory (DWA-GEN-006): channel locks, dedupe set, rate-limit counters.
// A restart resets all of it.

/** One command per channel at a time; channels run in parallel (DWA-GEN-004). */
export class ChannelLocks {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(channelId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(channelId) ?? Promise.resolve();
    const next = prev.then(work, work);
    const tail = next.catch(() => undefined);
    this.tails.set(channelId, tail);
    void tail.then(() => {
      if (this.tails.get(channelId) === tail) this.tails.delete(channelId);
    });
    return next;
  }
}

/** Remembers keys for a fixed time (DWA-SLK-002: envelope_id and trigger_id, 10 minutes). */
export class Dedupe {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when any key was seen within the ttl; records all keys. */
  check(keys: (string | undefined)[]): boolean {
    const t = this.now();
    for (const [k, exp] of this.seen) if (exp <= t) this.seen.delete(k);
    const present = keys.filter((k): k is string => k !== undefined && k !== '');
    const dup = present.some((k) => this.seen.has(k));
    for (const k of present) this.seen.set(k, t + this.ttlMs);
    return dup;
  }
}

/** Sliding-window counter per key (DWA-LIM-004: 10 starts per user per hour). */
export class RateLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly max = 10,
    readonly windowMs = 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true, or returns false when the key is over the limit. */
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
