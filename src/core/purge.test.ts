// Ways the global response purge can fail, written before the code.
import { createMemoryStore } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { purgeExpiredResponses } from "./responses.js";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const day = 86_400_000;
const iso = (offsetDays: number) => new Date(NOW + offsetDays * day).toISOString();
const row = (retainUntil: unknown, formId = "f") => ({ formId, formVersion: 1, submittedAt: iso(-100), values: {}, retainUntil }) as never;
const ids = async (store: ReturnType<typeof createMemoryStore>) => (await store.query("responses", { limit: 500 })).items.map((i) => i.id).sort();

describe("global response purge failures", () => {
  test("it deletes expired rows in every form and keeps live rows, rows with no date, and rows exactly at the date", async () => {
    const store = createMemoryStore();
    await store.put("responses", "a-old", row(iso(-1), "a"));
    await store.put("responses", "b-old", row(iso(-30), "b"));
    await store.put("responses", "a-live", row(iso(5), "a"));
    await store.put("responses", "b-edge", row(iso(0), "b"));
    await store.put("responses", "c-nodate", { formId: "c", formVersion: 1, submittedAt: iso(-100), values: {} });
    expect(await purgeExpiredResponses(store, NOW)).toBe(2);
    expect(await ids(store)).toEqual(["a-live", "b-edge", "c-nodate"]);
  });

  test("a date that is not a valid time is deleted, whatever it sorts like", async () => {
    const store = createMemoryStore();
    await store.put("responses", "words", row("not a date"));
    await store.put("responses", "number", row(12345));
    await store.put("responses", "junk-iso", row("2026-13-99T00:00:00.000Z"));
    await store.put("responses", "live", row(iso(3)));
    expect(await purgeExpiredResponses(store, NOW)).toBe(3);
    expect(await ids(store)).toEqual(["live"]);
  });

  test("a null date is deleted too, since an ordered read never reaches it", async () => {
    const store = createMemoryStore();
    await store.put("responses", "null-date", row(null));
    await store.put("responses", "live", row(iso(3)));
    expect(await purgeExpiredResponses(store, NOW)).toBe(1);
    expect(await ids(store)).toEqual(["live"]);
  });

  test("many live rows cost one page read, so they cannot block the purge", async () => {
    const store = createMemoryStore();
    await store.put("responses", "old", row(iso(-1), "z"));
    for (let i = 0; i < 300; i++) await store.put("responses", `live${i}`, row(iso(10 + i), "a"));
    let reads = 0;
    const counting = { ...store, transaction: ((fn: never) => (reads++, store.transaction(fn))) as typeof store.transaction };
    expect(await purgeExpiredResponses(counting as typeof store, NOW, { pages: 5, size: 10 })).toBe(1);
    expect(reads).toBeLessThanOrEqual(5);
  });

  test("a backlog bigger than the budget is cleared over several runs, and each run stays inside the budget", async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 95; i++) await store.put("responses", `old${String(i).padStart(3, "0")}`, row(iso(-200 + i)));
    await store.put("responses", "live", row(iso(1)));
    const budget = { pages: 3, size: 10 };
    expect(await purgeExpiredResponses(store, NOW, budget)).toBe(30);
    expect(await purgeExpiredResponses(store, NOW, budget)).toBe(30);
    while ((await purgeExpiredResponses(store, NOW, budget)) > 0);
    expect(await ids(store)).toEqual(["live"]);
  });
});
