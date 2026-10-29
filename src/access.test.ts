// Ways form access can fail, written before the code. They drive the real HTTP
// handler with the real memory adapters of agentic-identity.
import { createMemoryAuth, createMemoryStore, createSharing, createStoreAuth, issueCredential, type PrincipalContext } from "agentic-identity";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createFormRepo } from "./core/repo.js";
import { createTokenAuth } from "./core/token-auth.js";

const SECRET = "r".repeat(32);
const human = (id: string, scopes = ["*:admin"]): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes });
const agentOf = (owner: string, id: string, scopes: string[]): PrincipalContext => ({
  principalId: id,
  kind: "agent_of_human",
  chain: [{ id: owner, kind: "human" }, { id, kind: "agent_of_human" }],
  scopes,
});

const spec = (id: string) => ({ id, title: id, sections: [{ id: "s", title: "S", questions: [{ id: "n", type: "short_text", label: "N", required: true }] }] });

let store: ReturnType<typeof createMemoryStore>;
let app: ReturnType<typeof createApp>;
let issue: (ctx: PrincipalContext) => Promise<string>;
beforeEach(() => {
  store = createMemoryStore();
  const memory = createMemoryAuth();
  issue = (ctx) => memory.issue(ctx);
  app = createApp({ store, auth: memory.auth, rateLimitSecret: SECRET });
});

const call = (token: string | undefined, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/forms${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("who may call", () => {
  test("no credential or a wrong one is 401 on every route, and nothing is created", async () => {
    for (const token of [undefined, "nope", "a".repeat(100)]) {
      for (const [method, path] of [["GET", ""], ["POST", ""], ["GET", "/x"], ["POST", "/x/publish"], ["GET", "/x/responses"], ["GET", "/x/export"], ["POST", "/x/purge"], ["POST", "/x/shares"], ["GET", "/x/audit"]]) {
        expect((await call(token, method, path, method === "POST" ? spec("x") : undefined)).status, `${method} ${path}`).toBe(401);
      }
    }
    expect((await store.query("forms")).items).toHaveLength(0);
  });

  test("a caller without the form:write scope cannot create a form", async () => {
    const reader = await issue(human("rita", ["form:read"]));
    expect((await call(reader, "POST", "", spec("a"))).status).toBe(403);
    expect((await store.query("forms")).items).toHaveLength(0);
  });

  test("a form id that sharing cannot hold is refused before anything is stored", async () => {
    const owner = await issue(human("olga"));
    expect((await call(owner, "POST", "", spec("has space"))).status).toBe(400);
    expect((await store.query("forms")).items).toHaveLength(0);
    expect((await store.query("resources")).items).toHaveLength(0);
  });

  test("a logic cycle is refused and leaves no owner row behind", async () => {
    const owner = await issue(human("olga"));
    const loop = { id: "loop", title: "L", sections: [{ id: "s", title: "S", questions: [
      { id: "a", type: "short_text", label: "A", showIf: { question: "b", op: "answered" } },
      { id: "b", type: "short_text", label: "B", showIf: { question: "a", op: "answered" } },
    ] }] };
    expect((await call(owner, "POST", "", loop)).status).toBe(422);
    expect((await store.query("resources")).items).toHaveLength(0);
    expect((await call(owner, "POST", "", spec("loop"))).status).toBe(201);
  });
});

describe("owner and roles", () => {
  test("the creator owns the form, a stranger gets 404, and the same id cannot be taken twice", async () => {
    const [olga, sam] = [await issue(human("olga")), await issue(human("sam"))];
    expect((await call(olga, "POST", "", spec("a"))).status).toBe(201);
    expect((await call(olga, "GET", "/a")).status).toBe(200);
    expect((await call(sam, "GET", "/a")).status).toBe(404);
    expect((await call(sam, "GET", "/ghost")).status).toBe(404);
    expect((await call(sam, "POST", "", spec("a"))).status).toBe(409);
    expect((await call(olga, "POST", "", spec("a"))).status).toBe(409);
  });

  test("a viewer reads the form but cannot edit it or see answers; an editor edits and sees answers but cannot share or purge", async () => {
    const [olga, vic, eda] = [await issue(human("olga")), await issue(human("vic")), await issue(human("eda"))];
    await call(olga, "POST", "", { ...spec("a"), publish: true });
    expect((await call(olga, "POST", "/a/shares", { subject: "vic", kind: "human", role: "viewer" })).status).toBe(200);
    expect((await call(olga, "POST", "/a/shares", { subject: "eda", kind: "human", role: "editor" })).status).toBe(200);

    expect((await call(vic, "GET", "/a")).status).toBe(200);
    const q = { question: { id: "m", type: "short_text", label: "M" } };
    expect((await call(vic, "POST", "/a/questions", q)).status).toBe(403);
    expect((await call(vic, "GET", "/a/responses")).status).toBe(403);
    expect((await call(vic, "GET", "/a/export")).status).toBe(403);

    expect((await call(eda, "POST", "/a/questions", q)).status).toBe(201);
    expect((await call(eda, "POST", "/a/publish")).status).toBe(200);
    expect((await call(eda, "GET", "/a/responses")).status).toBe(200);
    expect((await call(eda, "GET", "/a/export")).status).toBe(200);
    expect((await call(eda, "POST", "/a/purge")).status).toBe(403);
    expect((await call(eda, "POST", "/a/shares", { subject: "sam", kind: "human", role: "viewer" })).status).toBe(403);
    expect((await call(eda, "GET", "/a/audit")).status).toBe(403);
    expect((await call(olga, "POST", "/a/purge")).status).toBe(200);
  });

  test("a bad role or subject is 400, and a revoked grant gives 404 again", async () => {
    const [olga, vic] = [await issue(human("olga")), await issue(human("vic"))];
    await call(olga, "POST", "", spec("a"));
    for (const body of [{ subject: "vic", kind: "human", role: "king" }, { subject: "vic", kind: "human", role: "constructor" }, { subject: "a/b", role: "viewer" }, { role: "viewer" }, { subject: "vic" }]) {
      expect((await call(olga, "POST", "/a/shares", body)).status, JSON.stringify(body)).toBe(400);
    }
    await call(olga, "POST", "/a/shares", { subject: "vic", kind: "human", role: "viewer" });
    expect((await call(vic, "GET", "/a")).status).toBe(200);
    expect((await call(olga, "DELETE", "/a/shares/vic?kind=human")).status).toBe(200);
    expect((await call(vic, "GET", "/a")).status).toBe(404);
  });

  test("the last owner cannot be removed", async () => {
    const olga = await issue(human("olga"));
    await call(olga, "POST", "", spec("a"));
    expect((await call(olga, "DELETE", "/a/shares/olga?kind=human")).status).toBe(409);
    expect((await call(olga, "GET", "/a")).status).toBe(200);
  });

  test("the list shows only forms the caller holds a role on", async () => {
    const [olga, sam] = [await issue(human("olga")), await issue(human("sam"))];
    await call(olga, "POST", "", spec("a"));
    await call(olga, "POST", "", spec("b"));
    await call(sam, "POST", "", spec("c"));
    await call(olga, "POST", "/b/shares", { subject: "sam", kind: "human", role: "viewer" });
    const names = async (token: string) => ((await (await call(token, "GET", "")).json()) as { forms: { id: string }[] }).forms.map((f) => f.id).sort();
    expect(await names(olga)).toEqual(["a", "b"]);
    expect(await names(sam)).toEqual(["b", "c"]);
  });
});

describe("credentials kept in the store", () => {
  test("a credential from issueCredential names the caller, and a revoked or unknown one does not", async () => {
    const durable = createApp({ store, auth: createStoreAuth(store), rateLimitSecret: SECRET });
    await store.put("principals", "ada", { id: "ada", kind: "human", scopes: ["*:admin"] });
    const token = await issueCredential(store, { principalId: "ada", kind: "session" });
    const send = (bearer: string, method = "GET", body?: unknown) =>
      durable.request("/api/v1/forms", { method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await send(token, "POST", spec("a"))).status).toBe(201);
    expect(((await (await send(token)).json()) as { forms: { id: string }[] }).forms.map((f) => f.id)).toEqual(["a"]);
    expect((await send("aid_unknown")).status).toBe(401);
    await store.put("credentials", (await store.query("credentials")).items[0]!.id, { principalId: "ada", kind: "session", revokedAt: 1 });
    expect((await send(token)).status).toBe(401);
  });
});

describe("the list", () => {
  test("an agent with no form scope sees no forms, and a stranger's list writes no audit row", async () => {
    const olga = await issue(human("olga"));
    await call(olga, "POST", "", spec("a"));
    const writer = await issue(agentOf("olga", "bot", ["doc:read"]));
    expect(((await (await call(writer, "GET", "")).json()) as { forms: unknown[] }).forms).toEqual([]);
    const stranger = await issue(human("sam"));
    const before = (await store.query("audit")).items.length;
    expect(((await (await call(stranger, "GET", "")).json()) as { forms: unknown[] }).forms).toEqual([]);
    expect((await store.query("audit")).items.length).toBe(before);
  });
});

describe("rows from other apps or bad data", () => {
  test("rights on a resource of another type with the same id give nothing on the form", async () => {
    // A form from before roles has no resource row. Bob owns a "doc" with the same id.
    const repo = createFormRepo(store);
    await repo.save({ ...spec("x"), version: 1, status: "draft" } as never);
    await repo.publish("x");
    const bob = human("bob", ["doc:admin"]);
    await createSharing(store).createResource(bob, { id: "x", type: "doc" });
    const token = await issue(bob);
    for (const [method, path] of [["GET", "/x"], ["POST", "/x/purge"], ["GET", "/x/responses"], ["GET", "/x/export"], ["POST", "/x/shares"], ["GET", "/x/audit"]]) {
      expect((await call(token, method, path, method === "POST" ? { subject: "bob", kind: "human", role: "owner" } : undefined)).status, `${method} ${path}`).toBe(404);
    }
  });

  test("the list leaves out a grant with no form resource or a role that is not valid", async () => {
    const olga = await issue(human("olga"));
    await call(olga, "POST", "", spec("a"));
    await call(olga, "POST", "", spec("b"));
    await store.put("grants", "b:human:olga", { resourceId: "b", subjectKind: "human", subjectId: "olga", role: "king" });
    await store.put("grants", "ghost:human:olga", { resourceId: "ghost", subjectKind: "human", subjectId: "olga", role: "owner" });
    await createSharing(store).createResource(human("olga", ["doc:write"]), { id: "d", type: "doc" });
    const ids = ((await (await call(olga, "GET", "")).json()) as { forms: { id: string }[] }).forms.map((f) => f.id);
    expect(ids).toEqual(["a"]);
  });
});

describe("keeping an owner", () => {
  test("an owner cannot demote the last owner, but can once there is another", async () => {
    const olga = await issue(human("olga"));
    await call(olga, "POST", "", spec("a"));
    expect((await call(olga, "POST", "/a/shares", { subject: "olga", kind: "human", role: "viewer" })).status).toBe(409);
    expect((await call(olga, "GET", "/a/audit")).status).toBe(200);
    expect((await call(olga, "POST", "/a/shares", { subject: "sam", kind: "human", role: "owner" })).status).toBe(200);
    expect((await call(olga, "POST", "/a/shares", { subject: "olga", kind: "human", role: "viewer" })).status).toBe(200);
  });

  test("a form id taken by an owner row with no form can be made by that owner, and only by that owner", async () => {
    const [olga, sam] = [await issue(human("olga")), await issue(human("sam"))];
    await createSharing(store).createResource(human("olga"), { id: "z", type: "form" });
    expect((await call(sam, "POST", "", spec("z"))).status).toBe(409);
    expect((await call(olga, "POST", "", spec("z"))).status).toBe(201);
    expect((await call(olga, "GET", "/z")).status).toBe(200);
  });

  test("only owner, editor, and viewer can be shared", async () => {
    const olga = await issue(human("olga"));
    await call(olga, "POST", "", spec("a"));
    expect((await call(olga, "POST", "/a/shares", { subject: "sam", kind: "human", role: "commenter" })).status).toBe(400);
  });

  test("a caller with an empty chain is 401, and a token over 512 bytes cannot be set", async () => {
    const odd = await issue({ principalId: "x", kind: "human", chain: [], scopes: ["*:admin"] });
    expect((await call(odd, "POST", "", spec("a"))).status).toBe(401);
    expect(() => createTokenAuth("t".repeat(513))).toThrow("API token");
  });
});

describe("agents act with narrowed rights", () => {
  test("an agent of the owner keeps only the scopes it was given, even though the owner has more", async () => {
    const olga = await issue(human("olga"));
    await call(olga, "POST", "", { ...spec("a"), publish: true });
    const reader = await issue(agentOf("olga", "bot", ["form:read"]));
    const writer = await issue(agentOf("olga", "bot2", ["form:write"]));
    const q = { question: { id: "m", type: "short_text", label: "M" } };
    expect((await call(reader, "GET", "/a")).status).toBe(200);
    expect((await call(reader, "POST", "/a/questions", q)).status).toBe(403);
    expect((await call(reader, "GET", "/a/responses")).status).toBe(403);
    expect((await call(writer, "POST", "/a/questions", q)).status).toBe(201);
    expect((await call(writer, "POST", "/a/purge")).status).toBe(403);
    expect((await call(writer, "POST", "/a/shares", { subject: "bot", kind: "human", role: "owner" })).status).toBe(403);
  });
});

describe("audit and global purge", () => {
  test("reading answers is audited with the caller chain, and only an owner reads the log", async () => {
    const [olga, eda] = [await issue(human("olga")), await issue(human("eda"))];
    await call(olga, "POST", "", { ...spec("a"), publish: true });
    await call(olga, "POST", "/a/shares", { subject: "eda", kind: "human", role: "editor" });
    await call(eda, "GET", "/a/responses");
    await call(eda, "POST", "/a/purge"); // denied, and audited as denied
    const log = ((await (await call(olga, "GET", "/a/audit")).json()) as { entries: { principalId: string; outcome: string; action: string }[] }).entries;
    expect(log.some((e) => e.principalId === "eda" && e.outcome === "allowed")).toBe(true);
    expect(log.some((e) => e.principalId === "eda" && e.outcome === "denied" && e.action === "admin")).toBe(true);
    expect(JSON.stringify(log)).not.toContain("@");
  });

  test("the global purge needs the all-forms admin scope", async () => {
    const [olga, root] = [await issue(human("olga", ["form:admin"])), await issue(human("root"))];
    const purge = (token: string) => app.request("/api/v1/purge", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect((await purge(olga)).status).toBe(403);
    expect((await purge(root)).status).toBe(200);
  });
});

describe("the public page stays anonymous", () => {
  test("a respondent needs no credential, is still rate limited, and cannot reach /api/v1", async () => {
    const olga = await issue(human("olga"));
    await call(olga, "POST", "", { ...spec("a"), publish: true });
    const limited = createApp({ store, auth: createMemoryAuth().auth, rateLimit: { limit: 2, windowMs: 60_000 }, rateLimitSecret: SECRET });
    const send = () => limited.request("/f/a", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" }, body: JSON.stringify({ answers: { n: "x" } }) });
    expect([(await send()).status, (await send()).status, (await send()).status]).toEqual([201, 201, 429]);
    expect((await limited.request("/api/v1/forms/a/responses")).status).toBe(401);
  });
});

describe("kinds and erase", () => {
  test("a person and an agent with the same id hold separate roles", async () => {
    const [olga, ana] = [await issue(human("olga")), await issue(human("ana"))];
    const bot = await issue({ principalId: "ana", kind: "agent", chain: [{ id: "ana", kind: "agent" }], scopes: ["form:write"] } as PrincipalContext);
    await call(olga, "POST", "", { ...spec("a"), publish: true });
    await call(olga, "POST", "/a/shares", { subject: "ana", kind: "agent", role: "editor" });
    expect((await call(bot, "GET", "/a")).status).toBe(200);
    expect((await call(ana, "GET", "/a")).status).toBe(404);
    expect(((await (await call(bot, "GET", "")).json()) as { forms: unknown[] }).forms).toHaveLength(1);
    expect(((await (await call(ana, "GET", "")).json()) as { forms: unknown[] }).forms).toHaveLength(0);
    expect((await call(olga, "DELETE", "/a/shares/ana?kind=human")).status).toBe(200); // no such grant, nothing changes
    expect((await call(bot, "GET", "/a")).status).toBe(200);
    expect((await call(olga, "DELETE", "/a/shares/ana?kind=agent")).status).toBe(200);
    expect((await call(bot, "GET", "/a")).status).toBe(404);
  });

  test("a share needs a kind, and never defaults one", async () => {
    const olga = await issue(human("olga"));
    await call(olga, "POST", "", spec("a"));
    for (const kind of [undefined, "user_token", "robot"]) {
      expect((await call(olga, "POST", "/a/shares", { subject: "vic", kind, role: "viewer" })).status).toBe(400);
    }
    expect((await call(olga, "DELETE", "/a/shares/vic")).status).toBe(400);
  });

  test("deleting a form erases its answers, versions, grants, and resource", async () => {
    const [olga, eda] = [await issue(human("olga")), await issue(human("eda"))];
    await call(olga, "POST", "", { ...spec("a"), publish: true });
    await call(olga, "POST", "/a/shares", { subject: "eda", kind: "human", role: "editor" });
    await store.put("responses", "r1", { id: "r1", formId: "a", submittedAt: "2026-01-01T00:00:00.000Z" } as never);
    expect((await call(eda, "DELETE", "/a")).status).toBe(403);
    expect((await call(olga, "DELETE", "/a")).status).toBe(200);
    expect((await call(olga, "GET", "/a")).status).toBe(404);
    for (const collection of ["forms", "form_versions", "responses", "grants", "resources"]) {
      expect((await store.query(collection)).items, collection).toHaveLength(0);
    }
    // the id is free again
    expect((await call(olga, "POST", "", spec("a"))).status).toBe(201);
  });
});
