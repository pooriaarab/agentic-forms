// Bad ids are the caller's fault: 400 for a malformed id, 404 for a form that is not there. Never 500.
import { createMemoryAuth, createMemoryStore, type PrincipalContext } from "agentic-identity";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";

const SECRET = "r".repeat(32);
const root: PrincipalContext = { principalId: "root", kind: "human", chain: [{ id: "root", kind: "human" }], scopes: ["*:admin"] };
const spec = { id: "real", title: "Real", publish: true, sections: [{ id: "s", title: "S", questions: [{ id: "n", type: "short_text", label: "N" }] }] };

let app: ReturnType<typeof createApp>;
let token: string;
beforeEach(async () => {
  const memory = createMemoryAuth();
  token = await memory.issue(root);
  app = createApp({ store: createMemoryStore(), auth: memory.auth, rateLimitSecret: SECRET });
  await app.request("/api/v1/forms", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(spec) });
});

const api = (method: string, path: string, body: unknown = {}) =>
  app.request(`/api/v1/forms/${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body) });

// Every route that takes a form id, with the body it needs.
const routes: [string, string, unknown?][] = [
  ["GET", "{id}"],
  ["POST", "{id}/questions", { question: { id: "m", type: "short_text", label: "M" } }],
  ["POST", "{id}/publish"],
  ["GET", "{id}/responses"],
  ["GET", "{id}/export"],
  ["POST", "{id}/purge"],
  ["POST", "{id}/shares", { subject: "vic", kind: "human", role: "viewer" }],
  ["DELETE", "{id}/shares/vic?kind=human"],
  ["GET", "{id}/audit"],
];
const malformed = ["has%20space", "a%2Fb", "x".repeat(101), "__x__", "%00", "a.b", "%F0%9F%98%80", "a%5Cb"];

describe("a malformed form id is 400", () => {
  for (const [method, path, body] of routes) {
    test(`${method} /api/v1/forms/${path}`, async () => {
      for (const id of malformed) {
        const res = await api(method, path.replace("{id}", id), body);
        expect(res.status, id).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("invalid_id");
      }
    });
  }

  test("GET and POST /f/:id", async () => {
    for (const id of malformed) {
      expect((await app.request(`/f/${id}`)).status, id).toBe(400);
      const post = await app.request(`/f/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: {} }) });
      expect(post.status, id).toBe(400);
    }
  });

  test("a malformed subject in DELETE shares", async () => {
    for (const subject of ["has%20space", "a%2Fb", "x".repeat(129)]) expect((await api("DELETE", `real/shares/${subject}`)).status, subject).toBe(400);
  });
});

describe("the id check comes after the access check", () => {
  test("a caller with no role on the form gets 404 for a bad subject, not 400", async () => {
    const memory = createMemoryAuth();
    const stranger = await memory.issue({ ...root, principalId: "sam", chain: [{ id: "sam", kind: "human" }] });
    const own = createApp({ store: createMemoryStore(), auth: memory.auth, rateLimitSecret: SECRET });
    const owner = await memory.issue(root);
    await own.request("/api/v1/forms", { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, body: JSON.stringify(spec) });
    const res = await own.request("/api/v1/forms/real/shares/has%20space", { method: "DELETE", headers: { authorization: `Bearer ${stranger}` } });
    expect(res.status).toBe(404);
  });
});

describe("a form that is not there is 404", () => {
  for (const [method, path, body] of routes) {
    test(`${method} /api/v1/forms/${path}`, async () => {
      const res = await api(method, path.replace("{id}", "ghost"), body);
      expect(res.status).toBe(404);
    });
  }

  test("GET and POST /f/:id", async () => {
    expect((await app.request("/f/ghost")).status).toBe(404);
    expect((await app.request("/f/ghost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: {} }) })).status).toBe(404);
  });
});

describe("a bad query is 400", () => {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  test("a limit that is not a whole number from 1 to 1000, and a cursor that was never issued", async () => {
    const bad = ["limit=abc", "limit=-1", "limit=0", "limit=1.5", "limit=1001", "limit=1e9", "limit=", "cursor=%00", "cursor=garbage", `cursor=${b64([{ a: 1 }, "x"])}`, `cursor=${b64(["x", 5])}`, `cursor=${b64("x")}`, `cursor=${b64([1])}`];
    for (const query of bad) expect((await api("GET", `real/responses?${query}`)).status, query).toBe(400);
  });

  test("the edges are accepted, and a page with a limit gives a cursor that works", async () => {
    for (const n of ["x", "y", "z"]) await app.request("/f/real", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: { n } }) });
    expect((await api("GET", "real/responses?limit=1000")).status).toBe(200);
    const first = (await (await api("GET", "real/responses?limit=1")).json()) as { items: unknown[]; nextCursor?: string };
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    const next = await api("GET", `real/responses?limit=1&cursor=${first.nextCursor}`);
    expect(next.status).toBe(200);
    expect(((await next.json()) as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe("a form id the store reserves", () => {
  test("a spec with such an id is refused with 400, not 500", async () => {
    const res = await app.request("/api/v1/forms", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...spec, id: "__x__" }) });
    expect(res.status).toBe(400);
  });
});
