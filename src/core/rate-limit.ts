import type { Doc, Store } from "agentic-identity";
import { purgeOrdered, type PurgeBudget } from "./purge.js";

const COLLECTION = "rate_limits";

export interface RateLimitConfig {
  /** Hits allowed per client in each window. */
  limit: number;
  windowMs: number;
}

const MIN_SECRET_BYTES = 32;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A keyed hash, so a stored id cannot be reversed by trying every address. */
async function keyedHash(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A counter must hold whole numbers, and its window must not start further ahead than one window. */
const validCounter = (doc: Doc, now: number) =>
  isCount(doc.start) && isCount(doc.count) && isWhole(doc.windowMs) && doc.start - now <= doc.windowMs;

/**
 * A fixed-window counter kept in the Store, so every isolate shares it and a
 * restart does not reset it. The key is hashed with a secret of 32 bytes or
 * more before it is stored. A counter that is not valid blocks the client
 * until `purgeRateLimits` removes it.
 */
export function createRateLimiter(store: Store, config: RateLimitConfig, secret: string, now: () => number = Date.now) {
  if (!isWhole(config.limit) || !isWhole(config.windowMs)) throw new Error("the rate limit and its window must be whole numbers above 0");
  if (typeof secret !== "string" || new TextEncoder().encode(secret).length < MIN_SECRET_BYTES) {
    throw new Error(`the rate limit secret must be a string of at least ${MIN_SECRET_BYTES} bytes`);
  }
  const blocked = Math.max(1, Math.ceil(config.windowMs / 1000));
  return {
    /** Counts one hit. Returns 0 when it is allowed, or the seconds to wait. */
    async hit(key: string): Promise<number> {
      const id = await keyedHash(secret, key);
      return store.transaction(async (tx) => {
        const t = now();
        const found = await tx.get(COLLECTION, id);
        if (found !== null && !validCounter(found, t)) return blocked;
        if (found === null || t - (found.start as number) >= config.windowMs) {
          await tx.put(COLLECTION, id, { start: t, count: 1, windowMs: config.windowMs });
          return 0;
        }
        const count = found.count as number;
        if (count >= config.limit) return Math.max(1, Math.ceil(((found.start as number) + config.windowMs - t) / 1000));
        await tx.put(COLLECTION, id, { start: found.start, count: count + 1, windowMs: config.windowMs });
        return 0;
      });
    },
  };
}

/**
 * Deletes counters whose window ended, and counters that are not valid. It
 * reads oldest first, then from the other end for values that sort last.
 */
export async function purgeRateLimits(store: Store, now: number = Date.now(), budget?: PurgeBudget): Promise<number> {
  const finished = (doc: Doc) => !validCounter(doc, now) || now - (doc.start as number) >= (doc.windowMs as number);
  return (
    (await purgeOrdered(store, COLLECTION, { orderBy: { field: "start" } }, finished, budget)) +
    (await purgeOrdered(store, COLLECTION, { orderBy: { field: "start", direction: "desc" } }, (doc) => !validCounter(doc, now), budget))
  );
}
