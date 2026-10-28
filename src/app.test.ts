// Ways the public page and its submit route can fail. Written before the code.
// Each test drives the real Hono app through its fetch handler.
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import type { Form } from "./core/form.js";
import { createFormRepo } from "./core/repo.js";
import { createResponses } from "./core/responses.js";
import { createMemoryStore } from "./core/store.js";

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
    const app = createApp({ store });
    await repo.save(base());
    expect((await app.request("/f/f")).status).toBe(404);
    expect((await app.request("/f/none")).status).toBe(404);
  });

  test("text from the form author is escaped", async () => {
    await publish(base({ title: evil, notice: evil, sections: [{ id: "s", title: evil, questions: [{ id: "c", type: "dropdown", label: evil, required: false, choices: [evil] }] }] }));
    const html = await (await createApp({ store }).request("/f/f")).text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("the page loads nothing from outside and locks the policy", async () => {
    await publish(base());
    const res = await createApp({ store }).request("/f/f");
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
    const html = await (await createApp({ store }).request("/f/f")).text();
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
    const html = await (await createApp({ store }).request("/f/f")).text();
    expect(html).toContain("We use your name to reply.");
    expect(html).toContain("30 days");
    expect(html).toContain('id="consent"');
  });
});

describe("submit", () => {
  test("a good answer is stored as a row", async () => {
    await publish(base());
    const res = await post(createApp({ store }), { answers: { name: "Ada", color: "blue" } });
    expect(res.status).toBe(201);
    expect((await responses.list("f")).items[0].data.values).toEqual({ name: "Ada", color: "blue" });
  });

  test("bad JSON is 400, an oversized body is 413, bad answers are 422, and nothing is stored", async () => {
    await publish(base());
    const app = createApp({ store });
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
    const app = createApp({ store });
    expect((await post(app, { answers: { name: "Ada" } })).status).toBe(422);
    expect((await post(app, { answers: { name: "Ada" }, consent: true })).status).toBe(201);
    expect((await responses.list("f")).items[0].data).toMatchObject({ consent: true });
  });

  test("the rate limit answers 429 per client and recovers after the window", async () => {
    await publish(base());
    let now = 0;
    const app = createApp({ store, rateLimit: { limit: 2, windowMs: 1000 }, now: () => now });
    const send = (ip: string) => post(app, { answers: { name: "a" } }, { "cf-connecting-ip": ip });
    expect([(await send("1.1.1.1")).status, (await send("1.1.1.1")).status]).toEqual([201, 201]);
    const blocked = await send("1.1.1.1");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("1");
    expect((await send("2.2.2.2")).status).toBe(201);
    now = 1001;
    expect((await send("1.1.1.1")).status).toBe(201);
  });

  test("the bot check is off by default and blocks when it says no", async () => {
    await publish(base());
    expect((await post(createApp({ store }), { answers: { name: "a" } })).status).toBe(201);
    const closed = createApp({ store, botCheck: (_req, body) => body.botToken === "ok" });
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
    expect((await responses.list("f")).items.map((r) => r.data.values.name)).toEqual(["new"]);
    await repo.save(base({ retentionDays: undefined }));
    await repo.publish("f");
    await responses.submit("f", { name: "forever" }, { now: () => 0 });
    expect(await responses.purgeExpired("f", 99 * day)).toBe(1);
    expect((await responses.list("f")).items.map((r) => r.data.values.name)).toContain("forever");
  });

  test("a retention of zero or a fraction is an unsound form", async () => {
    await expect(repo.save(base({ retentionDays: 0 }))).rejects.toThrow("retention");
    await expect(repo.save(base({ retentionDays: 1.5 }))).rejects.toThrow("retention");
  });
});
