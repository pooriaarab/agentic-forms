// Ways an update can fail: a forged mark, a lost mark, a stale write, a caller with no right, bad logic.
import { createMemoryStore, type Auth } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createOps } from "./ops.js";

const q = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "short_text" as const, label: id, ...extra });
const spec = (questions: unknown[]) => ({ title: "T", sections: [{ id: "s", title: "S", questions }] });
const ids = (form: { sections: { questions: { id: string }[] }[] }) => form.sections[0]!.questions.map((x) => x.id);
const marks = (form: { sections: { questions: { id: string; madeBy?: string }[] }[] }) => Object.fromEntries(form.sections[0]!.questions.map((x) => [x.id, x.madeBy]));

describe("ops.update", () => {
  test("a new or changed question takes the caller's mark, an unchanged one keeps its own", async () => {
    const ops = createOps(createMemoryStore());
    await ops.create({ id: "f", ...spec([q("a"), q("b")]) }, false, "human");
    const next = await ops.update("f", spec([q("b"), q("a", { label: "A!" }), q("c")]), "agent");
    expect(ids(next)).toEqual(["b", "a", "c"]);
    expect(marks(next)).toEqual({ b: "human", a: "agent", c: "agent" });
  });

  test("a mark sent by the caller is dropped", async () => {
    const ops = createOps(createMemoryStore());
    const made = await ops.create({ id: "f", ...spec([q("a", { madeBy: "human" })]) }, false, "agent");
    expect(marks(made)).toEqual({ a: "agent" });
    const unknown = await ops.update("f", spec([q("a", { madeBy: "human" }), q("z", { madeBy: "human" })]));
    expect(marks(unknown)).toEqual({ a: "agent", z: undefined });
  });

  test("an update with no caller kind sets no mark, and a removed question is gone", async () => {
    const ops = createOps(createMemoryStore());
    await ops.create({ id: "f", ...spec([q("a"), q("b")]) });
    expect(ids(await ops.update("f", spec([q("b")])))).toEqual(["b"]);
  });

  test("a published form starts a new draft, and a stale expectedVersion is refused", async () => {
    const ops = createOps(createMemoryStore());
    await ops.create({ id: "f", ...spec([q("a")]) }, true);
    const draft = await ops.update("f", { ...spec([q("a"), q("b")]), expectedVersion: 1 });
    expect(draft).toMatchObject({ version: 2, status: "draft" });
    await expect(ops.update("f", { ...spec([q("a")]), expectedVersion: 1 })).rejects.toThrow(/version 2/);
  });

  test("a condition that points forward is refused and nothing is stored", async () => {
    const ops = createOps(createMemoryStore());
    await ops.create({ id: "f", ...spec([q("a")]) });
    await expect(ops.update("f", spec([q("a", { showIf: { question: "b", op: "answered" } }), q("b")]))).rejects.toThrow();
    expect(ids(await ops.get("f"))).toEqual(["a"]);
  });

  test("an unknown form is not_found", async () => {
    await expect(createOps(createMemoryStore()).update("none", spec([q("a")]))).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("PUT /api/v1/forms/:id", () => {
  const as = (kind: "human" | "agent", id = "p"): Auth => ({ authenticate: async () => ({ principalId: id, kind, chain: [{ id, kind }], scopes: ["*:admin"] }) });
  const put = (app: ReturnType<typeof createApp>, body: unknown) => app.request("/api/v1/forms/f", { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer x" }, body: JSON.stringify(body) });

  test("the mark follows the caller's kind, and a forged mark does not count", async () => {
    const store = createMemoryStore();
    const human = createApp({ store, auth: as("human"), rateLimit: false });
    await human.request("/api/v1/forms", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x" }, body: JSON.stringify({ id: "f", ...spec([q("a")]) }) });
    const res = await put(human, spec([q("a"), q("b", { madeBy: "agent" })]));
    expect(res.status).toBe(200);
    expect(marks((await res.json()) as never)).toEqual({ a: "human", b: "human" });
    await human.request("/api/v1/forms/f/shares", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x" }, body: JSON.stringify({ subject: "p", kind: "agent", role: "editor" }) });
    const agent = createApp({ store, auth: as("agent"), rateLimit: false });
    expect(marks((await (await put(agent, spec([q("a"), q("b", { label: "B" })]))).json()) as never)).toEqual({ a: "human", b: "agent" });
  });

  test("a stale expectedVersion is 409, bad logic is 422, a bad spec is 400, a stranger is 404", async () => {
    const store = createMemoryStore();
    const owner = createApp({ store, auth: as("human", "ada"), rateLimit: false });
    await owner.request("/api/v1/forms", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x" }, body: JSON.stringify({ id: "f", ...spec([q("a")]) }) });
    const stale = await put(owner, { ...spec([q("a")]), expectedVersion: 9 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "version_conflict" });
    expect((await put(owner, spec([q("a", { showIf: { question: "zz", op: "answered" } })]))).status).toBe(422);
    expect((await put(owner, { title: "" })).status).toBe(400);
    const stranger = createApp({ store, auth: as("human", "eve"), rateLimit: false });
    expect((await put(stranger, spec([q("a")]))).status).toBe(404);
  });
});
