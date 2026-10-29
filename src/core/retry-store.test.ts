import { StoreConflictError, createMemoryStore } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { VersionConflictError } from "./repo.js";
import { retryingStore } from "./retry-store.js";

// A store whose put fails with the given error for the first `fails` calls.
function flaky(error: Error, fails: number) {
  const inner = createMemoryStore();
  let calls = 0;
  return { calls: () => calls, store: retryingStore({ ...inner, put: async (c, id, doc) => (++calls <= fails ? Promise.reject(error) : inner.put(c, id, doc)) }) };
}

describe("retryingStore", () => {
  test("a write that lost the race to another process runs again and lands", async () => {
    const { store, calls } = flaky(new StoreConflictError("the store file changed during the write"), 3);
    await store.put("things", "a", { n: 1 });
    expect(calls()).toBe(4);
    expect(await store.get("things", "a")).toEqual({ n: 1 });
  });

  test("a stuck lock, a version conflict and a plain conflict fail on the first call", async () => {
    for (const error of [new StoreConflictError("the store file is locked by another process"), new VersionConflictError("x", 1, 2), new StoreConflictError()]) {
      const { store, calls } = flaky(error, 5);
      await expect(store.put("things", "a", { n: 1 })).rejects.toBe(error);
      expect(calls()).toBe(1);
    }
  });

  test("the retries have a cap", async () => {
    const { store, calls } = flaky(new StoreConflictError("the store file changed during the write"), Infinity);
    await expect(store.put("things", "a", { n: 1 })).rejects.toThrow("changed during the write");
    expect(calls()).toBe(200);
  }, 60_000);
});
