// Invites and share links over the real HTTP handler, with the memory adapters of agentic-identity.
import { createMemoryAuth, createMemoryStore, type PrincipalContext } from "agentic-identity";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";

const human = (id: string, scopes = ["*:admin"]): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes });
const spec = (id: string) => ({ id, title: id, sections: [{ id: "s", title: "S", questions: [{ id: "n", type: "short_text", label: "N" }] }] });
const NOW = Date.parse("2026-10-28T10:00:00Z");

let store: ReturnType<typeof createMemoryStore>;
let app: ReturnType<typeof createApp>;
let issue: (ctx: PrincipalContext) => Promise<string>;
let olga: string;
let sam: string;
beforeEach(async () => {
  store = createMemoryStore();
  const memory = createMemoryAuth();
  issue = (ctx) => memory.issue(ctx);
  app = createApp({ store, auth: memory.auth, rateLimitSecret: "r".repeat(32), now: () => NOW });
  [olga, sam] = [await issue(human("olga")), await issue(human("sam"))];
  await call(olga, "POST", "", spec("a"));
  await call(olga, "POST", "", spec("b"));
});

const call = (token: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/forms${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (res: Response) => (await res.json()) as Record<string, any>;

describe("invites", () => {
  test("an owner invites by email or handle and lists them without the email", async () => {
    const mail = await call(olga, "POST", "/a/invites", { role: "viewer", email: "Ada@Example.com", expiresInMs: 60_000 });
    expect(mail.status).toBe(201);
    expect((await call(olga, "POST", "/a/invites", { role: "editor", handle: "helper" })).status).toBe(201);
    const listed = await call(olga, "GET", "/a/invites");
    const { invites } = await json(listed);
    expect(invites).toHaveLength(2);
    expect(invites.map((i: { for: string }) => i.for).sort()).toEqual(["email", "handle"]);
    expect(JSON.stringify(invites)).not.toContain("example.com");
  });

  // The route checks a handle with its own copy of the library rule. These edges must agree with the library, so a drift fails here.
  test("a handle at the edge of the library rule is accepted, and one past it is refused", async () => {
    for (const handle of ["ab", "a".repeat(32), "a-b_9"]) expect((await call(olga, "POST", "/a/invites", { role: "viewer", handle })).status, handle).toBe(201);
    for (const handle of ["a", "a".repeat(33), "A1", "-ab"]) expect((await call(olga, "POST", "/a/invites", { role: "viewer", handle })).status, handle).toBe(400);
  });

  test("an invite row that grants a role no invite can give is not listed", async () => {
    await store.put("invites", "odd", { id: "odd", resourceId: "a", role: "owner", handle: "helper" });
    await store.put("invites", "fine", { id: "fine", resourceId: "a", role: "viewer", handle: "helper" });
    await store.put("invites", "soft", { id: "soft", resourceId: "a", role: "commenter", handle: "helper" });
    expect((await json(await call(olga, "GET", "/a/invites"))).invites.map((i: { id: string }) => i.id).sort()).toEqual(["fine", "soft"]);
  });

  test("bad input is 400 and stores nothing", async () => {
    const bad = [
      { role: "owner", handle: "x" },
      { role: "commenter", handle: "x" },
      { handle: "x" },
      { role: "viewer" },
      { role: "viewer", email: "a@b.co", handle: "x" },
      { role: "viewer", email: "nope" },
      { role: "viewer", email: `${"a".repeat(250)}@b.co` },
      { role: "viewer", handle: "has space" },
      { role: "viewer", handle: "Claude" },
      { role: "viewer", handle: "a" },
      { role: "viewer", handle: "1bot" },
      { role: "viewer", handle: "b".repeat(33) },
      { role: "viewer", handle: "x", expiresInMs: Number.MAX_SAFE_INTEGER },
      { role: "viewer", handle: "x", expiresInMs: -5 },
      { role: "viewer", handle: "x", expiresInMs: "9" },
    ];
    for (const body of bad) expect((await call(olga, "POST", "/a/invites", body)).status, JSON.stringify(body)).toBe(400);
    expect((await store.query("invites")).items).toHaveLength(0);
    for (const query of ["limit=0", "limit=x", "cursor=%00"]) expect((await call(olga, "GET", `/a/invites?${query}`)).status, query).toBe(400);
  });

  test("a non-owner and a stranger cannot invite or list", async () => {
    await call(olga, "POST", "/a/shares", { subject: "sam", kind: "human", role: "editor" });
    expect((await call(sam, "POST", "/a/invites", { role: "viewer", handle: "x" })).status).toBe(403);
    expect((await call(sam, "GET", "/a/invites")).status).toBe(403);
    expect((await call(sam, "POST", "/b/invites", { role: "viewer", handle: "x" })).status).toBe(404);
    expect((await store.query("invites")).items).toHaveLength(0);
  });
});

describe("share links", () => {
  test("an owner makes a link, lists it without the token, and revokes it", async () => {
    const made = await call(olga, "POST", "/a/links", { role: "viewer", signedInOnly: true, expiresInMs: 60_000 });
    expect(made.status).toBe(201);
    const link = await json(made);
    expect(link.token.length).toBeGreaterThan(20);
    const listed = await call(olga, "GET", "/a/links");
    const body = await json(listed);
    expect(body.links).toEqual([{ id: link.id, role: "viewer", signedInOnly: true, expiresAt: NOW + 60_000 }]);
    expect(JSON.stringify(body)).not.toContain(link.token);
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect((await call(olga, "DELETE", `/a/links/${link.id}`)).status).toBe(200);
    expect((await json(await call(olga, "GET", "/a/links"))).links[0].revokedAt).toBe(NOW);
  });

  test("bad input is 400 and stores nothing", async () => {
    for (const body of [{ role: "owner" }, { role: "viewer", signedInOnly: "yes" }, { role: "viewer", expiresInMs: 0 }, { role: "viewer", expiresInMs: 1 }, { role: "viewer", expiresInMs: Number.MAX_SAFE_INTEGER }, {}, []]) {
      expect((await call(olga, "POST", "/a/links", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await store.query("links")).items).toHaveLength(0);
  });

  test("a second revoke keeps the first revoke time and the audit trail short", async () => {
    const link = await json(await call(olga, "POST", "/a/links", { role: "viewer" }));
    expect((await call(olga, "DELETE", `/a/links/${link.id}`)).status).toBe(200);
    const audits = async () => (await store.query("audit")).items.filter((i) => i.data.action === "link.revoke").length;
    expect(await audits()).toBe(1);
    expect((await call(olga, "DELETE", `/a/links/${link.id}`)).status).toBe(200);
    expect(await audits()).toBe(1);
    expect((await json(await call(olga, "GET", "/a/links"))).links[0].revokedAt).toBe(NOW);
  });

  test("an editor link is made and listed", async () => {
    const link = await json(await call(olga, "POST", "/a/links", { role: "editor" }));
    expect((await json(await call(olga, "GET", "/a/links"))).links).toEqual([{ id: link.id, role: "editor", signedInOnly: false }]);
  });

  test("a link row that grants a role no link can give is not listed", async () => {
    await store.put("links", "odd", { id: "odd", resourceId: "a", role: "owner", tokenHash: "x", signedInOnly: false });
    await store.put("links", "bare", { id: "bare", resourceId: "a", tokenHash: "x" });
    await store.put("links", "stale", { id: "stale", resourceId: "a", role: "viewer", tokenHash: "x", expiresAt: "2026-11-01" });
    expect((await json(await call(olga, "GET", "/a/links"))).links).toEqual([]);
    // A commenter link works in agentic-identity, so the owner must see it and can revoke it.
    await store.put("links", "soft", { id: "soft", resourceId: "a", role: "commenter", tokenHash: "x", signedInOnly: false });
    expect((await json(await call(olga, "GET", "/a/links"))).links).toEqual([{ id: "soft", role: "commenter", signedInOnly: false }]);
    expect((await call(olga, "DELETE", "/a/links/soft")).status).toBe(200);
  });

  test("a link of another form cannot be revoked here, even by an owner of both", async () => {
    const link = await json(await call(olga, "POST", "/b/links", { role: "viewer" }));
    expect((await call(olga, "DELETE", `/a/links/${link.id}`)).status).toBe(404);
    expect((await call(olga, "DELETE", "/a/links/missing")).status).toBe(404);
    expect((await call(olga, "DELETE", "/a/links/bad%20id")).status).toBe(404);
    expect((await json(await call(olga, "GET", "/b/links"))).links[0].revokedAt).toBeUndefined();
  });

  test("a non-owner cannot make, list, or revoke a link", async () => {
    await call(olga, "POST", "/a/shares", { subject: "sam", kind: "human", role: "editor" });
    const link = await json(await call(olga, "POST", "/a/links", { role: "viewer" }));
    expect((await call(sam, "POST", "/a/links", { role: "viewer" })).status).toBe(403);
    expect((await call(sam, "GET", "/a/links")).status).toBe(403);
    expect((await call(sam, "DELETE", `/a/links/${link.id}`)).status).toBe(403);
    expect((await store.query("links")).items).toHaveLength(1);
  });
});
