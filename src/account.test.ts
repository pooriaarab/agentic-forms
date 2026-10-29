// Failure cases for the account contract, written before the code.
//  1. A bad subject (no id, unknown kind) or a missing store is refused.
//  2. Export holds only what the subject owns or holds: another person's form, answers, grants, and audit rows never appear.
//  3. Export is plain JSON and keeps the grant of a form the subject only edits.
//  4. Erase removes a form the subject alone owns, with snapshots, answers, grants, and audit, and counts them.
//  5. A form with a second owner stays: only the subject's grant goes. A form shared to the subject stays.
//  6. A person and an agent with one id are two subjects.
//  7. A second erase counts zero and changes nothing.
//  8. A form that cannot be erased stops the run and names the form id.
//  9. Audit rows with no known root kind, anonymous rows, a delegated chain rooted in its first step, and rows on other resource types are not matched.
// 10. A grant with no kind stops both calls. An owner grant with no kind keeps the form.
// 11. A stop after the data went keeps the counts of that form in the message, and a repeat finishes.
import { createMemoryStore, createSharing, type PrincipalContext, type Store } from "agentic-identity";
import { describe, expect, it } from "vitest";
import { createOps } from "./ops.js";
import { formsAccount } from "./account.js";

const ctx = (id: string, kind: "human" | "agent" = "human"): PrincipalContext => ({ principalId: id, kind, chain: [{ id, kind }], scopes: ["*:admin"] });
const ANA = { id: "ana", kind: "human" } as const;
const spec = (id: string) => ({ id, title: id, sections: [{ id: "s", title: "S", questions: [{ id: "q", type: "short_text", label: "Q" }] }] });

async function make(store: Store, id: string, owner: PrincipalContext) {
  await createSharing(store).createResource(owner, { id, type: "form" });
  const ops = createOps(store);
  await ops.create(spec(id), true);
  await ops.submit(id, { q: `${id}-answer` });
  await createSharing(store).can(owner, "read", id);
}

const all = async (store: Store, collection: string) => (await store.query(collection)).items;

describe("subject", () => {
  it("refuses a bad subject and a missing store", async () => {
    const store = createMemoryStore();
    for (const bad of [{ id: "", kind: "human" }, { id: "ana" }, { id: "ana", kind: "wizard" }, null]) {
      await expect(formsAccount.exportAccount(bad as never, { store })).rejects.toThrow(/subject/);
      await expect(formsAccount.eraseAccount(bad as never, { store })).rejects.toThrow(/subject/);
    }
    await expect(formsAccount.exportAccount(ANA, {} as never)).rejects.toThrow("needs deps.store");
    await expect(formsAccount.eraseAccount(ANA, undefined as never)).rejects.toThrow("needs deps.store");
  });
});

describe("exportAccount", () => {
  it("holds only the subject's data, as plain JSON, under stable names", async () => {
    const store = createMemoryStore();
    await make(store, "ana-form", ctx("ana"));
    await make(store, "bob-form", ctx("bob"));
    await createSharing(store).grant(ctx("bob"), "bob-form", { kind: "human", id: "ana" }, "editor");
    const out = await formsAccount.exportAccount(ANA, { store });
    expect(Object.keys(out)).toEqual(["forms", "form_versions", "responses", "grants", "audit"]);
    expect(out.forms).toMatchObject([{ id: "ana-form" }]);
    expect(out.form_versions).toMatchObject([{ id: "ana-form", version: 1 }]);
    expect(out.responses).toMatchObject([{ formId: "ana-form", values: { q: "ana-form-answer" } }]);
    expect(out.grants.map((g) => [g.resourceId, g.role])).toEqual(expect.arrayContaining([["ana-form", "owner"], ["bob-form", "editor"]]));
    expect(out.grants).toHaveLength(2);
    expect(out.audit.length).toBeGreaterThan(0);
    expect(out.audit.every((a) => a.rootId === "ana")).toBe(true);
    expect(JSON.stringify(out)).not.toContain("bob-form-answer");
    expect(JSON.parse(JSON.stringify(out))).toStrictEqual(out);
  });

  it("keeps a person and an agent with one id apart", async () => {
    const store = createMemoryStore();
    await make(store, "human-form", ctx("ana"));
    await make(store, "agent-form", ctx("ana", "agent"));
    const person = await formsAccount.exportAccount(ANA, { store });
    expect(person.forms).toMatchObject([{ id: "human-form" }]);
    const agent = await formsAccount.exportAccount({ id: "ana", kind: "agent" }, { store });
    expect(agent.forms).toMatchObject([{ id: "agent-form" }]);
  });
});

describe("eraseAccount", () => {
  it("erases a sole-owned form with its snapshots, answers, grants, and audit, and counts them", async () => {
    const store = createMemoryStore();
    await make(store, "ana-form", ctx("ana"));
    await make(store, "bob-form", ctx("bob"));
    const counts = await formsAccount.eraseAccount(ANA, { store });
    expect(counts).toEqual({ forms: 1, form_versions: 1, responses: 1, grants: 1, audit: expect.any(Number) });
    expect(counts.audit).toBeGreaterThan(0);
    expect((await all(store, "audit")).some((a) => a.data.rootId === "ana")).toBe(false);
    expect(await store.get("forms", "ana-form")).toBeNull();
    expect(await store.get("resources", "ana-form")).toBeNull();
    expect((await all(store, "responses")).map((r) => r.data.formId)).toEqual(["bob-form"]);
    expect((await all(store, "audit")).every((a) => a.data.rootId === "bob")).toBe(true);
    expect(await store.get("forms", "bob-form")).not.toBeNull();
  });

  it("leaves a co-owned form and a shared form, and drops only the subject's grant", async () => {
    const store = createMemoryStore();
    await make(store, "joint", ctx("bob"));
    await createSharing(store).grant(ctx("bob"), "joint", { kind: "human", id: "ana" }, "owner");
    await make(store, "theirs", ctx("bob"));
    await createSharing(store).grant(ctx("bob"), "theirs", { kind: "human", id: "ana" }, "editor");
    const counts = await formsAccount.eraseAccount(ANA, { store });
    expect(counts).toMatchObject({ forms: 0, form_versions: 0, responses: 0, grants: 2 });
    expect(await store.get("forms", "joint")).not.toBeNull();
    expect(await store.get("forms", "theirs")).not.toBeNull();
    expect(await store.get("grants", "joint:human:ana")).toBeNull();
    expect(await store.get("grants", "theirs:human:ana")).toBeNull();
    expect(await store.get("grants", "joint:human:bob")).not.toBeNull();
  });

  it("does not touch an agent with the same id", async () => {
    const store = createMemoryStore();
    await make(store, "agent-form", ctx("ana", "agent"));
    expect(await formsAccount.eraseAccount(ANA, { store })).toEqual({ forms: 0, form_versions: 0, responses: 0, grants: 0, audit: 0 });
    expect(await store.get("forms", "agent-form")).not.toBeNull();
    expect((await formsAccount.exportAccount({ id: "ana", kind: "agent" }, { store })).audit.length).toBeGreaterThan(0);
  });

  it("counts zero the second time and changes nothing", async () => {
    const store = createMemoryStore();
    await make(store, "ana-form", ctx("ana"));
    await make(store, "bob-form", ctx("bob"));
    await formsAccount.eraseAccount(ANA, { store });
    const before = JSON.stringify(await Promise.all(["forms", "form_versions", "responses", "grants", "audit", "resources"].map((c) => all(store, c))));
    expect(await formsAccount.eraseAccount(ANA, { store })).toEqual({ forms: 0, form_versions: 0, responses: 0, grants: 0, audit: 0 });
    expect(JSON.stringify(await Promise.all(["forms", "form_versions", "responses", "grants", "audit", "resources"].map((c) => all(store, c))))).toBe(before);
    const out = await formsAccount.exportAccount(ANA, { store });
    expect(Object.values(out).every((rows) => rows.length === 0)).toBe(true);
  });

  it("stops at a form with child resources, names it, and keeps its data", async () => {
    const store = createMemoryStore();
    await make(store, "ana-form", ctx("ana"));
    await store.put("resources", "child", { id: "child", type: "form", parentId: "ana-form" });
    await expect(formsAccount.eraseAccount(ANA, { store })).rejects.toThrow(/erase stopped at form ana-form/);
    expect(await store.get("forms", "ana-form")).not.toBeNull();
    expect((await all(store, "responses")).length).toBe(1);
    await expect(formsAccount.eraseAccount(ANA, { store })).rejects.toThrow(/ana-form/);
  });

  it("stops on a grant with no kind, and on an owner with no kind, and keeps the data", async () => {
    const store = createMemoryStore();
    await make(store, "ana-form", ctx("ana"));
    await store.put("grants", "ana-form:ana", { resourceId: "ana-form", subjectId: "ana", role: "viewer" });
    await expect(formsAccount.exportAccount(ANA, { store })).rejects.toThrow(/migrateGrants/);
    await expect(formsAccount.eraseAccount(ANA, { store })).rejects.toThrow(/migrateGrants/);
    await store.delete("grants", "ana-form:ana");
    await store.put("grants", "ana-form:legacy", { resourceId: "ana-form", subjectId: "zed", role: "owner" });
    await expect(formsAccount.eraseAccount(ANA, { store })).rejects.toThrow(/erase stopped at form ana-form/);
    expect(await store.get("forms", "ana-form")).not.toBeNull();
  });

  it("matches audit rows only with a known root kind, on forms", async () => {
    const store = createMemoryStore();
    await make(store, "bob-form", ctx("bob"));
    await store.put("audit", "anon", { id: "anon", rootId: "anonymous", principalKind: "anonymous", chain: [], resourceId: "bob-form" });
    await store.put("audit", "bare", { id: "bare", rootId: "ana", resourceId: "bob-form" });
    await store.put("audit", "other", { id: "other", rootId: "ana", chain: [{ id: "ana", kind: "human" }], resourceId: "doc-1" });
    await store.put("resources", "doc-1", { id: "doc-1", type: "document" });
    const agent = { id: "ana", kind: "agent" } as const;
    expect((await formsAccount.exportAccount({ id: "anonymous", kind: "agent" }, { store })).audit).toEqual([]);
    expect((await formsAccount.exportAccount(agent, { store })).audit).toEqual([]);
    expect((await formsAccount.exportAccount(ANA, { store })).audit.map((a) => a.id)).not.toContain("other");
    await formsAccount.eraseAccount(agent, { store });
    await formsAccount.eraseAccount(ANA, { store });
    expect((await all(store, "audit")).filter((a) => a.data.rootId !== "bob").map((a) => a.id).sort()).toEqual(["anon", "bare", "other"]);
  });

  it("keeps the counts of a form when the last step fails, and a repeat finishes", async () => {
    const store = createMemoryStore();
    await make(store, "ana-form", ctx("ana"));
    const real = store.transaction.bind(store);
    let fail = true;
    store.transaction = ((fn: never) => (fail ? Promise.reject(new Error("down")) : real(fn))) as typeof store.transaction;
    const stopped = await formsAccount.eraseAccount(ANA, { store }).catch((e: Error) => e);
    expect((stopped as Error).message).toMatch(/erase stopped at form ana-form: 0 forms, 1 snapshots, 1 responses/);
    expect(((stopped as Error).cause as Error | undefined)?.message).toBeDefined();
    fail = false;
    expect(await formsAccount.eraseAccount(ANA, { store })).toMatchObject({ forms: 1, form_versions: 0, responses: 0 });
    expect(await store.get("forms", "ana-form")).toBeNull();
  });

  it("roots an audit entry of a delegated chain in the first step", async () => {
    const store = createMemoryStore();
    await make(store, "ana-form", ctx("ana"));
    await store.put("audit", "bot", { id: "bot", rootId: "ana", resourceId: "ana-form", chain: [{ id: "ana", kind: "human" }, { id: "bot", kind: "agent" }] });
    await store.put("audit", "bot-agent", { id: "bot-agent", rootId: "ana", resourceId: "ana-form", chain: [{ id: "ana", kind: "agent" }, { id: "bot", kind: "agent" }] });
    expect((await formsAccount.exportAccount(ANA, { store })).audit.map((a) => a.id)).toContain("bot");
    expect((await formsAccount.exportAccount(ANA, { store })).audit.map((a) => a.id)).not.toContain("bot-agent");
    expect((await formsAccount.exportAccount({ id: "ana", kind: "agent" }, { store })).audit.map((a) => a.id)).toEqual(["bot-agent"]);
  });

  it("drops an editor grant even when another owner of that form has no kind", async () => {
    const store = createMemoryStore();
    await make(store, "bob-form", ctx("bob"));
    await createSharing(store).grant(ctx("bob"), "bob-form", { kind: "human", id: "ana" }, "editor");
    await store.put("grants", "bob-form:legacy", { resourceId: "bob-form", subjectId: "zed", role: "owner" });
    expect(await formsAccount.eraseAccount(ANA, { store })).toMatchObject({ forms: 0, grants: 1 });
    expect(await store.get("grants", "bob-form:human:ana")).toBeNull();
  });

  it("stops before any data goes when the owner grant has a key sharing does not honor", async () => {
    const store = createMemoryStore();
    await make(store, "ana-form", ctx("ana"));
    await store.delete("grants", "ana-form:human:ana");
    await store.put("grants", "ana-form:old", { resourceId: "ana-form", subjectKind: "human", subjectId: "ana", role: "owner" });
    await expect(formsAccount.eraseAccount(ANA, { store })).rejects.toThrow(/erase stopped at form ana-form/);
    expect(await store.get("forms", "ana-form")).not.toBeNull();
    expect((await all(store, "responses")).length).toBe(1);
  });

  it("stops on a grant with no resource id, and counts a duplicate grant once", async () => {
    const store = createMemoryStore();
    await make(store, "ana-form", ctx("ana"));
    await store.put("grants", "bad", { subjectKind: "human", subjectId: "ana", role: "editor" });
    await expect(formsAccount.exportAccount(ANA, { store })).rejects.toThrow(/no resource id/);
    await expect(formsAccount.eraseAccount(ANA, { store })).rejects.toThrow(/no resource id/);
    await store.delete("grants", "bad");
    await store.put("grants", "ana-form:zz", { resourceId: "ana-form", subjectKind: "human", subjectId: "ana", role: "editor" });
    expect(await formsAccount.eraseAccount(ANA, { store })).toMatchObject({ forms: 1, grants: 2 });
  });

  it("does not match an audit row whose chain root is another id", async () => {
    const store = createMemoryStore();
    await make(store, "bob-form", ctx("bob"));
    await store.put("audit", "odd", { id: "odd", rootId: "ana", resourceId: "bob-form", chain: [{ id: "bob", kind: "human" }] });
    expect((await formsAccount.exportAccount(ANA, { store })).audit).toEqual([]);
  });

  it("exports a form once when the subject holds two owner grants, and names no grant id in an error", async () => {
    const store = createMemoryStore();
    await make(store, "ana-form", ctx("ana"));
    await store.put("grants", "ana-form:zz", { resourceId: "ana-form", subjectKind: "human", subjectId: "ana", role: "owner" });
    expect((await formsAccount.exportAccount(ANA, { store })).forms).toHaveLength(1);
    await store.put("grants", "ana-form:ana", { resourceId: "ana-form", subjectId: "ana", role: "viewer" });
    const error = await formsAccount.exportAccount(ANA, { store }).catch((e: Error) => e);
    expect((error as Error).message).not.toContain("ana-form:ana");
    expect((error as Error).message).toMatch(/migrateGrants/);
  });

  it("erases a form whose only owner holds two owner grants, and stops before any grant goes when the standard one is missing", async () => {
    const store = createMemoryStore();
    await make(store, "ana-form", ctx("ana"));
    await store.put("grants", "ana-form:zz", { resourceId: "ana-form", subjectKind: "human", subjectId: "ana", role: "owner" });
    await make(store, "odd-form", ctx("ana"));
    await store.delete("grants", "odd-form:human:ana");
    await store.put("grants", "odd-form:old", { resourceId: "odd-form", subjectKind: "human", subjectId: "ana", role: "owner" });
    await expect(formsAccount.eraseAccount(ANA, { store })).rejects.toThrow(/erase stopped at form odd-form/);
    expect(await store.get("grants", "odd-form:old")).not.toBeNull();
    expect(await store.get("forms", "odd-form")).not.toBeNull();
    expect(await store.get("forms", "ana-form")).toBeNull();
  });
});
