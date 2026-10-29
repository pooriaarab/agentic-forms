// Ways the stored rate limiter can fail, written before the code.
import { createMemoryStore } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { createRateLimiter, purgeRateLimits } from "./rate-limit.js";

const SECRET = "s".repeat(32);

const config = { limit: 2, windowMs: 1000 };

describe("rate limiter failures", () => {
  test("two limiters on one store share the count, as two isolates do", async () => {
    const store = createMemoryStore();
    const [one, two] = [createRateLimiter(store, config, SECRET, () => 0), createRateLimiter(store, config, SECRET, () => 0)];
    expect([await one.hit("a"), await two.hit("a"), await one.hit("a")]).toEqual([0, 0, 1]);
  });

  test("parallel hits never let more than the limit through", async () => {
    const store = createMemoryStore();
    const limiter = createRateLimiter(store, config, SECRET, () => 0);
    const waits = await Promise.all(Array.from({ length: 10 }, () => limiter.hit("a")));
    expect(waits.filter((w) => w === 0)).toHaveLength(2);
  });

  test("a blocked hit writes nothing", async () => {
    const store = createMemoryStore();
    const limiter = createRateLimiter(store, config, SECRET, () => 0);
    for (let i = 0; i < 2; i++) await limiter.hit("a");
    const before = JSON.stringify(await store.query("rate_limits"));
    await limiter.hit("a");
    expect(JSON.stringify(await store.query("rate_limits"))).toBe(before);
  });

  test("the raw client key is never stored", async () => {
    const store = createMemoryStore();
    await createRateLimiter(store, config, SECRET, () => 0).hit("203.0.113.9");
    expect(JSON.stringify(await store.query("rate_limits"))).not.toContain("203.0.113.9");
  });

  test("the stored id is keyed: it is not the plain hash of the address, and it changes with the secret", async () => {
    const plain = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("203.0.113.9")))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const [one, two] = [createMemoryStore(), createMemoryStore()];
    await createRateLimiter(one, config, SECRET, () => 0).hit("203.0.113.9");
    await createRateLimiter(two, config, "t".repeat(32), () => 0).hit("203.0.113.9");
    const [a, b] = [one, two].map(async (s) => (await s.query("rate_limits")).items[0]!.id);
    expect(await a).not.toBe(plain);
    expect(await a).not.toBe(await b);
  });

  test("a missing, empty, or short secret, or a bad config, makes the limiter refuse to start", () => {
    const store = createMemoryStore();
    for (const secret of [undefined, "", "x".repeat(31)]) expect(() => createRateLimiter(store, config, secret as never)).toThrow("secret");
    for (const bad of [{ limit: NaN, windowMs: 1000 }, { limit: 0, windowMs: 1000 }, { limit: 2, windowMs: NaN }, { limit: 2, windowMs: 0 }, { limit: 2.5, windowMs: 1000 }]) {
      expect(() => createRateLimiter(store, bad, SECRET)).toThrow("whole numbers");
    }
  });

  test("a counter that starts far in the future blocks, and purge removes it", async () => {
    const store = createMemoryStore();
    const limiter = createRateLimiter(store, config, SECRET, () => 5000);
    await limiter.hit("a");
    const [{ id }] = (await store.query("rate_limits")).items;
    await store.put("rate_limits", id, { start: 1e15, count: 1, windowMs: 1000 });
    expect(await limiter.hit("a")).toBe(1);
    expect(await purgeRateLimits(store, 5000)).toBe(1);
    expect(await limiter.hit("a")).toBe(0);
  });

  test("purge reads a bounded number of pages and clears the rest on the next run", async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 25; i++) await store.put("rate_limits", `c${String(i).padStart(2, "0")}`, { start: i, count: 1, windowMs: 1 });
    expect(await purgeRateLimits(store, 1000, { pages: 2, size: 10 })).toBe(20);
    expect(await purgeRateLimits(store, 1000, { pages: 2, size: 10 })).toBe(5);
    expect((await store.query("rate_limits")).items).toHaveLength(0);
  });

  test("a counter that is not numbers blocks the client instead of resetting it", async () => {
    const store = createMemoryStore();
    const limiter = createRateLimiter(store, config, SECRET, () => 0);
    await limiter.hit("a");
    const [{ id }] = (await store.query("rate_limits")).items;
    for (const bad of [{ start: "0", count: 1, windowMs: 1000 }, { start: 0, count: null, windowMs: 1000 }, { start: 0, count: 1 }]) {
      await store.put("rate_limits", id, bad as never);
      expect(await limiter.hit("a")).toBeGreaterThan(0);
    }
  });

  test("the window resets after windowMs", async () => {
    const store = createMemoryStore();
    let now = 0;
    const limiter = createRateLimiter(store, config, SECRET, () => now);
    for (let i = 0; i < 3; i++) await limiter.hit("a");
    now = 1000;
    expect(await limiter.hit("a")).toBe(0);
  });

  test("purge deletes finished windows and bad counters, and keeps live ones", async () => {
    const store = createMemoryStore();
    await store.put("rate_limits", "done", { start: 0, count: 1, windowMs: 1000 });
    await store.put("rate_limits", "live", { start: 900, count: 1, windowMs: 1000 });
    await store.put("rate_limits", "bad", { start: "x", count: 1, windowMs: 1000 });
    await store.put("rate_limits", "nowindow", { start: 900, count: 1 });
    expect(await purgeRateLimits(store, 1000)).toBe(3);
    expect((await store.query("rate_limits")).items.map((i) => i.id)).toEqual(["live"]);
  });
});
