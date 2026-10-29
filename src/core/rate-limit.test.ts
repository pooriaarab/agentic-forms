// Ways the stored rate limiter can fail, written before the code.
import { createMemoryStore } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { createRateLimiter, purgeRateLimits } from "./rate-limit.js";

const config = { limit: 2, windowMs: 1000 };

describe("rate limiter failures", () => {
  test("two limiters on one store share the count, as two isolates do", async () => {
    const store = createMemoryStore();
    const [one, two] = [createRateLimiter(store, config, () => 0), createRateLimiter(store, config, () => 0)];
    expect([await one.hit("a"), await two.hit("a"), await one.hit("a")]).toEqual([0, 0, 1]);
  });

  test("parallel hits never let more than the limit through", async () => {
    const store = createMemoryStore();
    const limiter = createRateLimiter(store, config, () => 0);
    const waits = await Promise.all(Array.from({ length: 10 }, () => limiter.hit("a")));
    expect(waits.filter((w) => w === 0)).toHaveLength(2);
  });

  test("a blocked hit writes nothing", async () => {
    const store = createMemoryStore();
    const limiter = createRateLimiter(store, config, () => 0);
    for (let i = 0; i < 2; i++) await limiter.hit("a");
    const before = JSON.stringify(await store.query("rate_limits"));
    await limiter.hit("a");
    expect(JSON.stringify(await store.query("rate_limits"))).toBe(before);
  });

  test("the raw client key is never stored", async () => {
    const store = createMemoryStore();
    await createRateLimiter(store, config, () => 0).hit("203.0.113.9");
    expect(JSON.stringify(await store.query("rate_limits"))).not.toContain("203.0.113.9");
  });

  test("a counter that is not numbers blocks the client instead of resetting it", async () => {
    const store = createMemoryStore();
    const limiter = createRateLimiter(store, config, () => 0);
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
    const limiter = createRateLimiter(store, config, () => now);
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
