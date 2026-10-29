// Ways the owner backfill can fail, written before the code.
import { createMemoryAuth, createMemoryStore, createSharing, type PrincipalContext } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { createApp } from "../app.js";
import { backfillOwners } from "./backfill.js";
import { createFormRepo } from "./repo.js";

const human = (id: string, scopes = ["*:admin"]): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes });
const legacy = async (store: ReturnType<typeof createMemoryStore>, id: string) => {
  const repo = createFormRepo(store);
  await repo.save({ id, title: id, version: 1, status: "draft", sections: [{ id: "s", title: "S", questions: [{ id: "n", type: "short_text", label: "N" }] }] } as never);
};
const grants = async (store: ReturnType<typeof createMemoryStore>) => (await store.query("grants")).items.map((i) => i.id).sort();

describe("owner backfill", () => {
  test("a form with no resource row gets one owner row, and nothing else changes", async () => {
    const store = createMemoryStore();
    await legacy(store, "a");
    await legacy(store, "b");
    expect(await backfillOwners(store, "olga")).toEqual({ created: ["a", "b"], skipped: 0, conflicts: [], invalid: [] });
    expect(await grants(store)).toEqual(["a:olga", "b:olga"]);
    expect((await store.get("resources", "a"))?.type).toBe("form");
    expect((await store.get("grants", "a:olga"))?.role).toBe("owner");
  });

  test("a second run changes nothing", async () => {
    const store = createMemoryStore();
    await legacy(store, "a");
    await backfillOwners(store, "olga");
    const before = JSON.stringify((await store.query("grants")).items);
    expect(await backfillOwners(store, "olga")).toEqual({ created: [], skipped: 1, conflicts: [], invalid: [] });
    expect(await backfillOwners(store, "someone-else")).toEqual({ created: [], skipped: 1, conflicts: [], invalid: [] });
    expect(JSON.stringify((await store.query("grants")).items)).toBe(before);
  });

  test("a form that already has an owner keeps it, and the new owner gets no right on it", async () => {
    const store = createMemoryStore();
    await legacy(store, "mine");
    await createSharing(store).createResource(human("sam"), { id: "mine", type: "form" });
    await legacy(store, "old");
    expect(await backfillOwners(store, "olga")).toEqual({ created: ["old"], skipped: 1, conflicts: [], invalid: [] });
    expect(await grants(store)).toEqual(["mine:sam", "old:olga"]);
  });

  test("a form id held by a resource of another type is a conflict and is left alone", async () => {
    const store = createMemoryStore();
    await legacy(store, "x");
    await createSharing(store).createResource(human("bob", ["doc:write"]), { id: "x", type: "doc" });
    expect(await backfillOwners(store, "olga")).toEqual({ created: [], skipped: 0, conflicts: ["x"], invalid: [] });
    expect(await grants(store)).toEqual(["x:bob"]);
  });

  test("two runs at the same moment make one owner row per form", async () => {
    const store = createMemoryStore();
    for (const id of ["a", "b", "c"]) await legacy(store, id);
    const [one, two] = await Promise.all([backfillOwners(store, "olga"), backfillOwners(store, "olga")]);
    expect(one.created.length + two.created.length).toBe(3);
    expect(await grants(store)).toEqual(["a:olga", "b:olga", "c:olga"]);
  });

  test("a run stops at the limit, and the next run goes on from its cursor", async () => {
    const store = createMemoryStore();
    for (const id of ["a", "b", "c", "d", "e"]) await legacy(store, id);
    const first = await backfillOwners(store, "olga", { limit: 2 });
    expect(first.created).toEqual(["a", "b"]);
    expect(first.nextCursor).toBeTypeOf("string");
    expect(await grants(store)).toEqual(["a:olga", "b:olga"]);
    const second = await backfillOwners(store, "olga", { limit: 2, cursor: first.nextCursor });
    expect(second.created).toEqual(["c", "d"]);
    const third = await backfillOwners(store, "olga", { limit: 2, cursor: second.nextCursor });
    expect(third).toEqual({ created: ["e"], skipped: 0, conflicts: [], invalid: [] });
    expect(await grants(store)).toHaveLength(5);
  });

  test("a form id that sharing cannot hold is reported and does not stop the run", async () => {
    const store = createMemoryStore();
    for (const id of ["a", "my.form", "Umfrage 2025", "z"]) await legacy(store, id);
    const result = await backfillOwners(store, "olga");
    expect(result).toEqual({ created: ["a", "z"], skipped: 0, conflicts: [], invalid: ["Umfrage 2025", "my.form"] });
    expect(await grants(store)).toEqual(["a:olga", "z:olga"]);
  });

  test("a bad limit or cursor is refused and nothing is written", async () => {
    const store = createMemoryStore();
    await legacy(store, "a");
    for (const options of [{ limit: 0 }, { limit: 26 }, { limit: 1.5 }, { limit: NaN }, { limit: "5" }, { cursor: "junk" }, { cursor: 5 }]) {
      await expect(backfillOwners(store, "olga", options as never), JSON.stringify(options)).rejects.toThrow();
    }
    expect(await grants(store)).toEqual([]);
  });

  test("a bad owner is refused and nothing is written", async () => {
    const store = createMemoryStore();
    await legacy(store, "a");
    for (const owner of ["", "a b", "a/b", "x".repeat(129), undefined as unknown as string, 5 as unknown as string]) {
      await expect(backfillOwners(store, owner), String(owner)).rejects.toThrow("owner");
    }
    expect(await grants(store)).toEqual([]);
  });
});

describe("POST /api/v1/backfill-owners", () => {
  const setup = async () => {
    const store = createMemoryStore();
    const memory = createMemoryAuth();
    const app = createApp({ store, auth: memory.auth, rateLimitSecret: "r".repeat(32) });
    const call = async (ctx: PrincipalContext, path: string, method = "GET", body?: unknown) =>
      app.request(`/api/v1/${path}`, { method, headers: { authorization: `Bearer ${await memory.issue(ctx)}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { store, call };
  };

  test("an admin backfills, and the owner can then reach the form", async () => {
    const { store, call } = await setup();
    await legacy(store, "a");
    expect((await call(human("olga"), "forms/a")).status).toBe(404);
    const res = await call(human("root"), "backfill-owners", "POST", { owner: "olga" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: ["a"], skipped: 0, conflicts: [], invalid: [] });
    expect((await call(human("olga"), "forms/a")).status).toBe(200);
  });

  test("the route takes a limit and a cursor, and goes on page by page", async () => {
    const { store, call } = await setup();
    for (const id of ["a", "b", "c"]) await legacy(store, id);
    const first = (await (await call(human("root"), "backfill-owners", "POST", { owner: "olga", limit: 2 })).json()) as { created: string[]; nextCursor: string };
    expect(first.created).toEqual(["a", "b"]);
    const second = await (await call(human("root"), "backfill-owners", "POST", { owner: "olga", limit: 2, cursor: first.nextCursor })).json();
    expect(second).toEqual({ created: ["c"], skipped: 0, conflicts: [], invalid: [] });
  });

  test("a caller without the all-forms admin scope gets 403, and a bad owner gets 400", async () => {
    const { store, call } = await setup();
    await legacy(store, "a");
    expect((await call(human("olga", ["form:admin"]), "backfill-owners", "POST", { owner: "olga" })).status).toBe(403);
    for (const body of [{}, null, "x", [], { owner: "a b" }, { owner: 5 }, { owner: "olga", limit: 0 }, { owner: "olga", limit: 26 }, { owner: "olga", limit: 1.5 }, { owner: "olga", limit: "5" }, { owner: "olga", cursor: "junk" }, { owner: "olga", cursor: 5 }]) expect((await call(human("root"), "backfill-owners", "POST", body)).status).toBe(400);
    expect(await grants(store)).toEqual([]);
  });
});
