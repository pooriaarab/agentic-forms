// The UI is served by static assets in the Worker. These tests cover what the app itself must do for it.
import { createMemoryStore } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createOps } from "./ops.js";

describe("web UI hooks", () => {
  test("the root goes to the UI", async () => {
    const res = await createApp({ store: createMemoryStore(), rateLimitSecret: "r".repeat(32), ui: true }).request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ui/");
  });

  test("the fill page takes its look from the Worker's own stylesheet and nothing from another site", async () => {
    const store = createMemoryStore();
    await createOps(store).create({ id: "f", title: "F", sections: [{ id: "s", title: "S", questions: [{ id: "q", type: "short_text", label: "Q" }] }] }, true);
    const res = await createApp({ store, rateLimitSecret: "r".repeat(32) }).request("/f/f");
    const html = await res.text();
    expect(html).toContain('<link rel="stylesheet" href="/ui/styles.css">');
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("style-src 'self' 'nonce-");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toMatch(/https?:|\*/);
    expect(html).not.toMatch(/(?:href|src)="https?:/);
  });

  test("the fill page data does not tell who made a question", async () => {
    const store = createMemoryStore();
    await createOps(store).create({ id: "f", title: "F", sections: [{ id: "s", title: "S", questions: [{ id: "q", type: "short_text", label: "Q" }] }] }, true, "agent");
    expect((await createOps(store).get("f")).sections[0]!.questions[0]!.madeBy).toBe("agent");
    const html = await (await createApp({ store, rateLimitSecret: "r".repeat(32) }).request("/f/f")).text();
    expect(html).not.toContain("madeBy");
  });
});
