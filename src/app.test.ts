// Ways the public page and its submit route can fail. Written before the code.
// Each test drives the real Hono app through its fetch handler.
import { request as httpRequest, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import type { Form } from "./core/form.js";
import { createFormRepo } from "./core/repo.js";
import { createResponses } from "./core/responses.js";
import { createMemoryAuth, createMemoryStore } from "agentic-identity";

const evil = `<img src=x onerror=alert(1)>"`;
const base = (extra: Partial<Form> = {}): Form => ({
  id: "f",
  title: "Survey",
  version: 1,
  status: "draft",
  sections: [
    {
      id: "s",
      title: "About you",
      questions: [
        { id: "name", type: "short_text", label: "Name", required: true },
        { id: "color", type: "single_choice", label: "Color", required: false, choices: ["red", "blue"] },
        { id: "why", type: "long_text", label: "Why red", required: true, showIf: { question: "color", op: "equals", value: "red" } },
      ],
    },
  ],
  ...extra,
});

const SECRET = "r".repeat(32);
let repo: ReturnType<typeof createFormRepo>;
let responses: ReturnType<typeof createResponses>;
let store: ReturnType<typeof createMemoryStore>;
const publish = async (form: Form) => {
  await repo.save(form);
  await repo.publish(form.id);
};
const post = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/f/f", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => {
  store = createMemoryStore();
  repo = createFormRepo(store);
  responses = createResponses(store, repo);
});

describe("page", () => {
  test("a draft or missing form is a 404", async () => {
    const app = createApp({ rateLimitSecret: SECRET, store });
    await repo.save(base());
    expect((await app.request("/f/f")).status).toBe(404);
    expect((await app.request("/f/none")).status).toBe(404);
  });

  test("text from the form author is escaped", async () => {
    await publish(base({ title: evil, notice: evil, sections: [{ id: "s", title: evil, questions: [{ id: "c", type: "dropdown", label: evil, required: false, choices: [evil] }] }] }));
    const html = await (await createApp({ rateLimitSecret: SECRET, store }).request("/f/f")).text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("the page loads nothing from outside and locks the policy", async () => {
    await publish(base());
    const res = await createApp({ rateLimitSecret: SECRET, store }).request("/f/f");
    const html = await res.text();
    expect(html).not.toMatch(/(src|href|action)="https?:/);
    expect(html).not.toMatch(/@import|url\(/);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    const nonce = /nonce-([\w-]+)/.exec(csp)![1];
    expect(html.match(/<script[^>]*>/g)!.every((tag) => tag.includes(`nonce="${nonce}"`))).toBe(true);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("every control has a label, the page has a language and one main landmark", async () => {
    await publish(base());
    const html = await (await createApp({ rateLimitSecret: SECRET, store }).request("/f/f")).text();
    expect(html).toContain('<html lang="en">');
    expect(html.match(/<main/g)).toHaveLength(1);
    expect(html.match(/<h1/g)).toHaveLength(1);
    const ids = [...html.matchAll(/<(?:input|textarea|select)[^>]*\sid="([^"]+)"/g)].map((m) => m[1]).filter((id) => !id.startsWith("r-"));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(html).toContain(`<label for="${id}"`);
    expect(html).toContain("(required)");
  });

  test("the notice and retention show, with a required consent box", async () => {
    await publish(base({ notice: "We use your name to reply.", retentionDays: 30 }));
    const html = await (await createApp({ rateLimitSecret: SECRET, store }).request("/f/f")).text();
    expect(html).toContain("We use your name to reply.");
    expect(html).toContain("30 days");
    expect(html).toContain('id="consent"');
  });
});

describe("submit", () => {
  test("a good answer is stored as a row", async () => {
    await publish(base());
    const res = await post(createApp({ rateLimitSecret: SECRET, store }), { answers: { name: "Ada", color: "blue" } });
    expect(res.status).toBe(201);
    expect((await responses.list("f")).items[0].data.values).toEqual({ name: "Ada", color: "blue" });
  });

  test("bad JSON is 400, an oversized body is 413, bad answers are 422, and nothing is stored", async () => {
    await publish(base());
    const app = createApp({ rateLimitSecret: SECRET, store });
    expect((await post(app, "{nope")).status).toBe(400);
    expect((await post(app, { answers: { name: "x".repeat(70_000) } })).status).toBe(413);
    const bad = await post(app, { answers: { color: "blue" } });
    expect(bad.status).toBe(422);
    expect((await bad.json()).issues[0]).toMatchObject({ code: "required", question: "name" });
    expect((await post(app, { answers: "no" })).status).toBe(400);
    expect((await responses.list("f")).items).toEqual([]);
  });

  test("a form with a notice refuses an answer without consent", async () => {
    await publish(base({ notice: "Notice." }));
    const app = createApp({ rateLimitSecret: SECRET, store });
    expect((await post(app, { answers: { name: "Ada" } })).status).toBe(422);
    expect((await post(app, { answers: { name: "Ada" }, consent: true })).status).toBe(201);
    expect((await responses.list("f")).items[0].data).toMatchObject({ consent: true });
  });

  test("the rate limit answers 429 per client and recovers after the window", async () => {
    await publish(base());
    let now = 0;
    const app = createApp({ rateLimitSecret: SECRET, store, rateLimit: { limit: 2, windowMs: 1000 }, now: () => now });
    const send = (ip: string) => post(app, { answers: { name: "a" } }, { "cf-connecting-ip": ip });
    expect([(await send("1.1.1.1")).status, (await send("1.1.1.1")).status]).toEqual([201, 201]);
    const blocked = await send("1.1.1.1");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("1");
    expect((await send("2.2.2.2")).status).toBe(201);
    now = 1001;
    expect((await send("1.1.1.1")).status).toBe(201);
  });

  test("a post to an unknown or unpublished form makes no counter", async () => {
    const app = createApp({ rateLimitSecret: SECRET, store });
    expect((await app.request("/f/ghost", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await store.query("rate_limits")).items).toHaveLength(0);
  });

  test("the app refuses to start without a rate limit secret of 32 bytes, unless the limit is off", () => {
    for (const rateLimitSecret of [undefined, "", "x".repeat(31)]) expect(() => createApp({ store, rateLimitSecret })).toThrow("secret");
    expect(() => createApp({ store, rateLimit: false })).not.toThrow();
  });

  test("the purge route needs the token and deletes expired rows in every form", async () => {
    await publish(base());
    await store.put("responses", "old", { id: "old", formId: "f", formVersion: 1, submittedAt: "2020-01-01T00:00:00.000Z", values: {}, retainUntil: "2020-02-01T00:00:00.000Z" });
    const memory = createMemoryAuth();
    const admin = await memory.issue({ principalId: "ada", kind: "human", chain: [{ id: "ada", kind: "human" }], scopes: ["*:admin"] });
    const app = createApp({ rateLimitSecret: SECRET, store, auth: memory.auth });
    expect((await app.request("/api/v1/purge", { method: "POST" })).status).toBe(401);
    expect(await store.get("responses", "old")).not.toBeNull();
    const run = await app.request("/api/v1/purge", { method: "POST", headers: { authorization: `Bearer ${admin}` } });
    expect(await run.json()).toEqual({ purged: 1, rateLimits: 0 });
    expect(await store.get("responses", "old")).toBeNull();
  });

  test("the bot check is off by default and blocks when it says no", async () => {
    await publish(base());
    expect((await post(createApp({ rateLimitSecret: SECRET, store }), { answers: { name: "a" } })).status).toBe(201);
    const closed = createApp({ rateLimitSecret: SECRET, store, botCheck: (_req, body) => body.botToken === "ok" });
    expect((await post(closed, { answers: { name: "b" } })).status).toBe(403);
    expect((await post(closed, { answers: { name: "c" }, botToken: "ok" })).status).toBe(201);
    expect((await responses.list("f")).items).toHaveLength(2);
  });
});

describe("retention", () => {
  test("purge removes only expired rows and keeps rows with no limit", async () => {
    await publish(base({ retentionDays: 1 }));
    const day = 86_400_000;
    await responses.submit("f", { name: "old" }, { now: () => 0 });
    await responses.submit("f", { name: "new" }, { now: () => 2 * day });
    expect(await responses.purgeExpired("f", 1.5 * day)).toBe(1);
    expect((await responses.list("f", { now: 1.5 * day })).items.map((r) => r.data.values.name)).toEqual(["new"]);
    await repo.save(base({ retentionDays: undefined }));
    await repo.publish("f");
    await responses.submit("f", { name: "forever" }, { now: () => 0 });
    expect(await responses.purgeExpired("f", 99 * day)).toBe(1);
    expect((await responses.list("f", { now: 99 * day })).items.map((r) => r.data.values.name)).toContain("forever");
  });

  test("a row with a retain date that is not a date is purged, not kept", async () => {
    await publish(base({ retentionDays: 30 }));
    const day = 86_400_000;
    const keep = await responses.submit("f", { name: "keep" }, { now: () => 0 });
    for (const [id, retainUntil] of [["garbage", "garbage"], ["nothing", null], ["number", 5], ["object", {}], ["empty", ""]] as const) {
      await store.put("responses", id, { ...keep, id, retainUntil } as never);
    }
    expect(await responses.purgeExpired("f", day)).toBe(5);
    expect((await responses.list("f", { now: 0 })).items.map((r) => r.id)).toEqual([keep.id]);
  });

  test("list and export drop expired rows before any purge runs", async () => {
    await publish(base({ retentionDays: 1 }));
    const day = 86_400_000;
    await responses.submit("f", { name: "old" }, { now: () => 0 });
    await responses.submit("f", { name: "new" }, { now: () => 2 * day });
    const at = 1.5 * day;
    expect((await responses.list("f", { now: at })).items.map((r) => r.data.values.name)).toEqual(["new"]);
    const csv = await responses.exportCsv("f", at);
    expect(csv).toContain("new");
    expect(csv).not.toContain("old");
    // Nothing was purged: the old row is still stored, only hidden.
    expect(await responses.purgeExpired("f", at)).toBe(1);
  });

  test("the API list and export hide an expired row by the real clock", async () => {
    await publish(base({ retentionDays: 1 }));
    await responses.submit("f", { name: "stale" }, { now: () => 0 });
    await responses.submit("f", { name: "fresh" });
    const live = (await responses.list("f")).items.map((r) => r.data.values.name);
    expect(live).toEqual(["fresh"]);
    expect(await responses.exportCsv("f")).not.toContain("stale");
  });

  test("a form with a required file question cannot be published", async () => {
    const withFile = base({ sections: [{ id: "s", title: "S", questions: [{ id: "doc", type: "file", label: "Doc", required: true }] }] });
    await repo.save(withFile);
    await expect(repo.publish("f")).rejects.toThrow("file");
    expect(await repo.getPublished("f")).toBeNull();
    const optional = base({ sections: [{ id: "s", title: "S", questions: [{ id: "doc", type: "file", label: "Doc", required: false }] }] });
    await repo.save(optional);
    await expect(repo.publish("f")).resolves.toMatchObject({ status: "published" });
  });

  test("a retention of zero or a fraction is an unsound form", async () => {
    await expect(repo.save(base({ retentionDays: 0 }))).rejects.toThrow("retention");
    await expect(repo.save(base({ retentionDays: 1.5 }))).rejects.toThrow("retention");
  });
});


describe("body cap while streaming", () => {
  const CAP = 65_536;
  let server: Server | undefined;
  afterEach(() => server?.close());

  test("a stream with no length is cut off past the cap and 413 is the answer", async () => {
    await publish(base());
    const app = createApp({ rateLimitSecret: SECRET, store, rateLimit: false });
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024;
        controller.enqueue(new Uint8Array(1024).fill(120));
      },
    });
    const res = await app.request("/f/f", { method: "POST", headers: { "content-type": "application/json" }, body: endless, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(CAP * 4);
    expect((await responses.list("f")).items).toEqual([]);
  });

  test("a body of multi-byte text is counted in bytes, not characters", async () => {
    await publish(base());
    const app = createApp({ rateLimitSecret: SECRET, store, rateLimit: false });
    const name = "é".repeat(CAP / 2 + 100); // fewer characters than the cap, more bytes
    const body = JSON.stringify({ answers: { name } });
    expect(body.length).toBeLessThan(CAP);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(CAP);
    expect((await post(app, body)).status).toBe(413);
  });

  // Real HTTP: node sends the body with Transfer-Encoding: chunked and no Content-Length.
  async function sendChunked(chunks: string[]): Promise<{ status: number; sawLength: boolean }> {
    const app = createApp({ rateLimitSecret: SECRET, store, rateLimit: false });
    let sawLength = true;
    server = createServer(async (req, res) => {
      sawLength = req.headers["content-length"] !== undefined;
      const response = await app.fetch(new Request(`http://localhost${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: Readable.toWeb(req) as ReadableStream, duplex: "half" } as RequestInit));
      res.writeHead(response.status).end(await response.text());
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = httpRequest({ port, host: "127.0.0.1", path: "/f/f", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode!, sawLength }));
      });
      req.on("error", (error) => ((error as NodeJS.ErrnoException).code === "EPIPE" || (error as NodeJS.ErrnoException).code === "ECONNRESET" ? undefined : reject(error)));
      for (const chunk of chunks) req.write(chunk);
      req.end();
    });
  }

  test("e2e: a chunked body over the cap is refused with 413", async () => {
    await publish(base());
    const filler = "x".repeat(8192);
    const result = await sendChunked(['{"answers":{"name":"', ...Array(12).fill(filler), '"}}']);
    expect(result).toEqual({ status: 413, sawLength: false });
    expect((await responses.list("f")).items).toEqual([]);
  });

  test("e2e: a small chunked body is accepted", async () => {
    await publish(base());
    const result = await sendChunked(['{"answers":', '{"name":"Ada"}}']);
    expect(result).toEqual({ status: 201, sawLength: false });
    expect((await responses.list("f")).items.map((r) => r.data.values.name)).toEqual(["Ada"]);
  });
});
