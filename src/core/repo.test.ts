// Ways the form repository can fail, written before the code.
import { describe, expect, test } from "vitest";
import type { Form } from "./form.js";
import { FormError, createFormRepo } from "./repo.js";
import { createMemoryStore } from "./store.js";

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
