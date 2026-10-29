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

  test("a question moved to another section keeps its mark", async () => {
    const ops = createOps(createMemoryStore());
    await ops.create({ id: "f", title: "T", sections: [{ id: "s", title: "S", questions: [q("a")] }, { id: "t", title: "T2", questions: [] }] }, false, "human");
    const moved = await ops.update("f", { title: "T", sections: [{ id: "s", title: "S", questions: [] }, { id: "t", title: "T2", questions: [q("a")] }] }, "agent");
    expect(moved.sections[1]!.questions[0]).toMatchObject({ id: "a", madeBy: "human" });
  });

  test("two edits of one draft: the second, based on the old revision, is refused", async () => {
    const ops = createOps(createMemoryStore());
    const first = await ops.create({ id: "f", ...spec([q("a")]) });
    await ops.update("f", { ...spec([q("a"), q("c")]), expectedRevision: first.revision });
    await expect(ops.update("f", { ...spec([q("a", { label: "A!" })]), expectedRevision: first.revision })).rejects.toThrow(/changed since revision/);
    expect(ids(await ops.get("f"))).toEqual(["a", "c"]);
  });

  test("an absent notice or retention is kept, and null removes it", async () => {
    const ops = createOps(createMemoryStore());
    await ops.create({ id: "f", ...spec([q("a")]), notice: "We keep it.", retentionDays: 30 });
    expect(await ops.update("f", spec([q("a")]))).toMatchObject({ notice: "We keep it.", retentionDays: 30 });
    expect(await ops.update("f", { ...spec([q("a")]), notice: "New.", retentionDays: null })).toMatchObject({ notice: "New." });
    const cleared = await ops.update("f", { ...spec([q("a")]), notice: null });
    expect(cleared.notice).toBeUndefined();
    expect(cleared.retentionDays).toBeUndefined();
  });

  test("an empty rules object is not a change", async () => {
    const ops = createOps(createMemoryStore());
    await ops.create({ id: "f", ...spec([q("a")]) }, false, "human");
    expect(marks(await ops.update("f", spec([q("a", { rules: {} })]), "agent"))).toEqual({ a: "human" });
  });

  test("an update that races an erase does not bring the form back", async () => {
    const store = createMemoryStore();
    const ops = createOps(store);
    await ops.create({ id: "f", ...spec([q("a")]) });
    const real = store.transaction.bind(store);
    // Run the erase after update has read the form and before it saves.
    let erased = false;
    store.transaction = (async (fn: never) => {
      if (!erased) {
        erased = true;
        await ops.erase("f");
      }
      return real(fn);
    }) as typeof store.transaction;
    await expect(ops.update("f", spec([q("a", { label: "A!" })]))).rejects.toThrow(/was erased/);
    expect(await ops.repo.get("f")).toBeNull();
  });

  test("two updates at once cannot drop a notice by omission", async () => {
    const ops = createOps(createMemoryStore());
    await ops.create({ id: "f", ...spec([q("a")]) });
    const results = await Promise.allSettled([ops.update("f", { ...spec([q("a")]), notice: "Consent needed" }), ops.update("f", { ...spec([q("a")]), title: "T2" })]);
    const stored = await ops.get("f");
    // Either the second one lost the race and was refused, or it ran after the first and kept the notice.
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    if (results.every((r) => r.status === "fulfilled")) expect(stored.notice).toBe("Consent needed");
  });

  test("a condition that points forward is refused and nothing is stored", async () => {
    const ops = createOps(createMemoryStore());
    await ops.create({ id: "f", ...spec([q("a")]) });
    await expect(ops.update("f", spec([q("a", { showIf: { question: "b", op: "answered" } }), q("b")]))).rejects.toThrow();
    expect(ids(await ops.get("f"))).toEqual(["a"]);
  });

  test("publish with a stale expectedRevision is refused, and the draft stays a draft", async () => {
    const ops = createOps(createMemoryStore());
    const read = await ops.create({ id: "f", ...spec([q("a")]) });
    await ops.update("f", spec([q("a"), q("secret")])); // someone else edits after the read
    await expect(ops.publish("f", { expectedRevision: read.revision })).rejects.toThrow(/before you publish/);
    expect((await ops.get("f")).status).toBe("draft");
    expect((await ops.publish("f", { expectedRevision: (await ops.get("f")).revision })).status).toBe("published");
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

  test("POST publish takes an optional body: a stale revision is 409, a bad body is 400, no body publishes", async () => {
    const store = createMemoryStore();
    const app = createApp({ store, auth: as("human", "ada"), rateLimit: false });
    const json = { "content-type": "application/json", authorization: "Bearer x" };
    await app.request("/api/v1/forms", { method: "POST", headers: json, body: JSON.stringify({ id: "f", ...spec([q("a")]) }) });
    const publish = (body?: unknown) => app.request("/api/v1/forms/f/publish", { method: "POST", headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
    const stale = await publish({ expectedRevision: 5 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "version_conflict", counts: "revision" });
    expect((await publish({ expectedRevision: "x" })).status).toBe(400);
    expect((await publish({ other: 1 })).status).toBe(400);
    expect((await publish()).status).toBe(200);
  });

  test("a viewer is refused with 403", async () => {
    const store = createMemoryStore();
    const owner = createApp({ store, auth: as("human", "ada"), rateLimit: false });
    const json = { "content-type": "application/json", authorization: "Bearer x" };
    await owner.request("/api/v1/forms", { method: "POST", headers: json, body: JSON.stringify({ id: "f", ...spec([q("a")]) }) });
    await owner.request("/api/v1/forms/f/shares", { method: "POST", headers: json, body: JSON.stringify({ subject: "vi", kind: "human", role: "viewer" }) });
    const viewer = createApp({ store, auth: as("human", "vi"), rateLimit: false });
    expect((await put(viewer, spec([q("a", { label: "X" })]))).status).toBe(403);
    expect(ids((await (await owner.request("/api/v1/forms/f", { headers: json })).json()) as never)).toEqual(["a"]);
  });

  test("a stale expectedVersion is 409, bad logic is 422, a bad spec is 400, a stranger is 404", async () => {
    const store = createMemoryStore();
    const owner = createApp({ store, auth: as("human", "ada"), rateLimit: false });
    await owner.request("/api/v1/forms", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x" }, body: JSON.stringify({ id: "f", ...spec([q("a")]) }) });
    const stale = await put(owner, { ...spec([q("a")]), expectedVersion: 9 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "version_conflict" });
    const behind = await put(owner, { ...spec([q("a")]), expectedRevision: 0 });
    expect(behind.status).toBe(409);
    expect(await behind.json()).toMatchObject({ error: "version_conflict", counts: "revision", message: expect.stringContaining("revision 0") });
    expect((await put(owner, spec([q("a", { showIf: { question: "zz", op: "answered" } })]))).status).toBe(422);
    expect((await put(owner, { title: "" })).status).toBe(400);
    const stranger = createApp({ store, auth: as("human", "eve"), rateLimit: false });
    expect((await put(stranger, spec([q("a")]))).status).toBe(404);
  });
});
