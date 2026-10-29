// Ways the form repository can fail, written before the code.
import { describe, expect, test } from "vitest";
import type { Form } from "./form.js";
import { FormError, SnapshotExistsError, VersionConflictError, createFormRepo } from "./repo.js";
import { createMemoryStore } from "agentic-identity";

const form = (id: string, showIf?: Form["sections"][0]["showIf"]): Form => ({
  id,
  title: `Form ${id}`,
  version: 1,
  status: "draft",
  sections: [{ id: "s", title: "S", questions: [{ id: "a", type: "short_text", label: "A", required: false, showIf }] }],
});

describe("form repository failures", () => {
  test("an unsound form is refused and nothing is stored", async () => {
    const repo = createFormRepo(createMemoryStore());
    await expect(repo.save(form("f1", { question: "a", op: "answered" }))).rejects.toBeInstanceOf(FormError);
    expect(await repo.get("f1")).toBeNull();
  });

  test("a missing form reads as null, not an error", async () => {
    expect(await createFormRepo(createMemoryStore()).get("nope")).toBeNull();
  });

  test("an id with a slash is refused by the store", async () => {
    await expect(createFormRepo(createMemoryStore()).save(form("a/b"))).rejects.toThrow("invalid id");
  });

  test("a saved form reads back equal, and list returns every form past one page", async () => {
    const repo = createFormRepo(createMemoryStore());
    for (let i = 0; i < 120; i++) await repo.save(form(`f${String(i).padStart(3, "0")}`));
    expect(await repo.get("f007")).toEqual(form("f007"));
    expect(await repo.list()).toHaveLength(120);
  });
});

describe("two writers on one store", () => {
  const edited = (id: string, title: string): Form => ({ ...form(id), title });

  test("a save that races a publish cannot erase the publish", async () => {
    const store = createMemoryStore();
    const a = createFormRepo(store);
    const b = createFormRepo(store);
    await a.save(form("f"));
    await Promise.all([a.save(edited("f", "late edit")), b.publish("f")]);
    const head = (await a.get("f"))!;
    const frozen = await a.getVersion("f", 1);
    expect(frozen?.status).toBe("published");
    // The head either shows the publish or a draft of the next version.
    expect(head.status === "published" ? head.version === 1 : head.version === 2).toBe(true);
  });

  test("a published version is never replaced, even by a stale head", async () => {
    const store = createMemoryStore();
    const repo = createFormRepo(store);
    await repo.save(form("f"));
    const first = await repo.publish("f");
    // A writer that lost the race puts the old draft back as the head.
    await store.put("forms", "f", { ...first, status: "draft", title: "stale" } as never);
    await expect(repo.publish("f")).rejects.toBeInstanceOf(SnapshotExistsError);
    expect((await repo.getVersion("f", 1))?.title).toBe(first.title);
  });

  test("an edit based on an old head version is refused", async () => {
    const store = createMemoryStore();
    const a = createFormRepo(store);
    const b = createFormRepo(store);
    await a.save(form("f"));
    await a.publish("f");
    await a.save(edited("f", "from a"), { expectedVersion: 1 });
    await expect(b.save(edited("f", "from b"), { expectedVersion: 1 })).rejects.toBeInstanceOf(VersionConflictError);
    expect((await a.get("f"))?.title).toBe("from a");
  });

  test("a form with no head cannot be saved with an expected version", async () => {
    await expect(createFormRepo(createMemoryStore()).save(form("f"), { expectedVersion: 3 })).rejects.toBeInstanceOf(
      VersionConflictError,
    );
  });
});
