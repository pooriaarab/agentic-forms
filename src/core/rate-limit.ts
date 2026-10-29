import type { Store } from "agentic-identity";

const COLLECTION = "rate_limits";

export interface RateLimitConfig {
  /** Hits allowed per client in each window. */
  limit: number;
  windowMs: number;
}

const hash = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * A fixed-window counter kept in the Store, so every isolate shares it and a
 * restart does not reset it. The key is hashed before it is stored. A counter
 * that is not valid blocks the client until `purgeRateLimits` removes it.
 */
export function createRateLimiter(store: Store, config: RateLimitConfig, now: () => number = Date.now) {
  return {
    /** Counts one hit. Returns 0 when it is allowed, or the seconds to wait. */
    async hit(key: string): Promise<number> {
      const id = await hash(key);
      return store.transaction(async (tx) => {
        const t = now();
        const found = await tx.get(COLLECTION, id);
        if (found !== null && !(isCount(found.start) && isCount(found.count) && isCount(found.windowMs))) return Math.ceil(config.windowMs / 1000);
        if (found === null || t - (found.start as number) >= config.windowMs) {
          await tx.put(COLLECTION, id, { start: t, count: 1, windowMs: config.windowMs });
          return 0;
        }
        const count = found.count as number;
        const wait = Math.ceil(((found.start as number) + config.windowMs - t) / 1000);
        if (count >= config.limit) return wait;
        await tx.put(COLLECTION, id, { start: found.start, count: count + 1, windowMs: config.windowMs });
        return 0;
      });
    },
  };
}

/** Deletes counters whose window ended, and counters that are not valid. Returns the count. */
export async function purgeRateLimits(store: Store, now: number = Date.now()): Promise<number> {
  let purged = 0;
  let cursor: string | undefined;
  do {
    const page = await store.query(COLLECTION, { limit: 100, cursor });
    for (const { id, data } of page.items) {
      const valid = isCount(data.start) && isCount(data.windowMs);
      if (!valid || now - (data.start as number) >= (data.windowMs as number)) {
        await store.delete(COLLECTION, id);
        purged++;
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return purged;
}
