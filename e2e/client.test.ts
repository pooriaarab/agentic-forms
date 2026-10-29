// Drives the remote client against the real Worker under `wrangler dev`.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ApiError, createClient } from "../src/client.js";

const TOKEN = "e2e-client-token-0123456789-0123456789";
const RATE_SECRET = "e2e-rate-secret-0123456789-0123456789";
const PORT = 8870; // the Worker e2e file uses 8799 to 8840
const baseUrl = `http://127.0.0.1:${PORT}`;
// The inspector port is not the default, so this file can run next to the Worker e2e file.
// Close each connection, as the Worker e2e does, so an idle socket is never reused.
const fetchClose: typeof fetch = (input, init) => fetch(input, { ...init, headers: { connection: "close", ...(init?.headers as Record<string, string> | undefined) } });
let proc: ChildProcess;

beforeAll(async () => {
  proc = spawn("node_modules/.bin/wrangler", ["dev", "--local", "--ip", "127.0.0.1", "--port", String(PORT), "--inspector-port", "9330", "--persist-to", mkdtempSync(join(tmpdir(), "forms-d1-")), "--var", "FORMS_REGION:unknown", "--var", "FORMS_UNSAFE_LOCAL_REGION:1", "--var", `FORMS_RATE_SECRET:${RATE_SECRET}`, "--var", `FORMS_API_TOKEN:${TOKEN}`], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  let log = "";
  proc.stdout?.on("data", (d) => (log += d));
  proc.stderr?.on("data", (d) => (log += d));
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      await fetchClose(`${baseUrl}/health`);
      return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`wrangler dev did not start:\n${log.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
});
afterAll(() => void proc?.kill());

const client = () => createClient({ baseUrl, token: TOKEN, fetch: fetchClose });
const caught = async (work: Promise<unknown>) => work.then(() => undefined, (e: unknown) => e);

describe("remote client against the Worker", () => {
  test("a full loop: create, publish, submit, read, share, audit, erase", async () => {
    const api = client();
    expect((await api.health()).ok).toBe(true);
    const spec = { id: "poll", title: "Poll", notice: "We keep answers.", sections: [{ id: "s", title: "S", questions: [{ id: "color", type: "single_choice" as const, label: "Color", required: true, choices: ["red", "blue"] }] }] };
    expect((await api.createForm(spec)).status).toBe("draft");
    await api.addQuestion("poll", { id: "note", type: "short_text", label: "Note" }, { section: "s" });
    const edited = await api.updateForm("poll", { title: "Poll", notice: "We keep answers.", sections: [{ id: "s", title: "S", questions: [{ id: "note", type: "short_text", label: "Note" }, { id: "color", type: "single_choice", label: "Color", required: true, choices: ["red", "blue"] }] }], expectedVersion: 1 });
    expect(edited.sections[0]!.questions.map((q) => q.id)).toEqual(["note", "color"]);
    expect(edited.sections[0]!.questions.map((q) => q.madeBy)).toEqual(["agent", "agent"]);
    expect(await caught(api.updateForm("poll", { title: "x", sections: edited.sections, expectedVersion: 7 }))).toMatchObject({ status: 409, code: "version_conflict" });
    expect(await caught(api.publishForm("poll", { expectedRevision: 0 }))).toMatchObject({ status: 409, code: "version_conflict", body: { counts: "revision" } });
    expect((await api.publishForm("poll", { expectedRevision: edited.revision })).status).toBe("published");
    expect((await api.getForm("poll")).sections[0]!.questions.map((q) => q.id)).toEqual(["note", "color"]);
    expect((await api.listForms()).map((f) => f.id)).toEqual(["poll"]);

    // The public submit sends no token. A missing consent is a typed 422.
    const refused = await caught(api.submit("poll", { color: "red" }));
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 422, code: "invalid" });
    expect((refused as ApiError).issues).toHaveLength(1);
    expect(await api.submit("poll", { color: "red", note: "hi" }, { consent: true })).toEqual({ ok: true });

    const page = await api.listResponses("poll", { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ formId: "poll", consent: true, values: { color: "red", note: "hi" } });
    expect((await api.exportCsv("poll")).split("\n")[0]).toBe("response_id,submitted_at,form_version,note,color");
    expect(await api.purge("poll")).toEqual({ purged: 0 });

    await api.share("poll", { subject: "ada", kind: "human", role: "viewer" });
    await api.revokeShare("poll", "ada", "human");
    expect((await api.listAudit("poll")).entries.length).toBeGreaterThan(0);
    expect(await api.purgeAll()).toMatchObject({ purged: 0 });
    expect(await api.backfillOwners("ada")).toMatchObject({ skipped: expect.any(Number) });
    expect(await api.migrateGrants()).toMatchObject({ migrated: expect.any(Number), unresolved: [] });

    expect(await api.eraseForm("poll")).toMatchObject({ ok: true });
    expect(await caught(api.getForm("poll"))).toMatchObject({ status: 404, code: "not_found" });
  });

  test("a wrong token is a typed 401", async () => {
    const error = await caught(createClient({ baseUrl, token: "wrong-token", fetch: fetchClose }).listForms());
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: "unauthorized", name: "ApiError" });
  });

  test("a missing form is a typed 404, and a bad id is a typed 400", async () => {
    const api = client();
    expect(await caught(api.getForm("nothing-here"))).toMatchObject({ status: 404, code: "not_found" });
    expect(await caught(api.getForm("Bad Id!"))).toMatchObject({ status: 400, code: "invalid_id" });
    expect(await caught(api.submit("nothing-here", {}))).toMatchObject({ status: 404, code: "not_found" });
    // The public page answers a bad id with text. The text becomes the message.
    expect(await caught(api.submit("Bad Id!", {}))).toMatchObject({ status: 400, code: "http_400", message: "This form id is not valid." });
  });

  test("a bad spec is a typed 400 with issues", async () => {
    const error = await caught(client().createForm({ id: "bad" } as never));
    expect(error).toMatchObject({ status: 400, code: "invalid_spec" });
    expect((error as ApiError).issues?.length).toBeGreaterThan(0);
  });

  test("an aborted signal stops the call", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await caught(client().listForms({ signal: controller.signal }));
    expect(error).toMatchObject({ name: "AbortError" });
  });

  test("a signal aborts a call in flight", async () => {
    const controller = new AbortController();
    const inFlight: typeof fetch = (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const pending = caught(createClient({ baseUrl, token: TOKEN, fetch: inFlight }).listForms({ signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
  });

  test("an id of dots never reaches another route", async () => {
    const seen: string[] = [];
    const spy: typeof fetch = async (input) => (seen.push(String(input)), new Response("{}"));
    const api = createClient({ baseUrl, token: TOKEN, fetch: spy });
    for (const bad of ["..", ".", ""]) {
      expect(await caught(api.purge(bad))).toBeInstanceOf(TypeError);
      expect(await caught(api.publishForm(bad))).toBeInstanceOf(TypeError);
      expect(await caught(api.revokeShare("f", bad, "human"))).toBeInstanceOf(TypeError);
    }
    expect(seen).toEqual([]);
  });

  test("a failed call is never retried", async () => {
    let calls = 0;
    const counting: typeof fetch = (input, init) => (calls++, fetchClose(input, init));
    await caught(createClient({ baseUrl, token: TOKEN, fetch: counting }).createForm({ id: "x" } as never));
    expect(calls).toBe(1);
  });
});

describe("the client without a token", () => {
  test("submit and health work, and an API call throws before it sends", async () => {
    const api = createClient({ baseUrl, fetch: fetchClose });
    expect((await api.health()).ok).toBe(true);
    expect(await caught(api.submit("nothing-here", {}))).toMatchObject({ status: 404 });
    expect(await caught(api.listForms())).toBeInstanceOf(TypeError);
  });

  test("a 200 reply that is not JSON is an ApiError", async () => {
    const page: typeof fetch = async () => new Response("<html>portal</html>", { status: 200 });
    expect(await caught(createClient({ baseUrl, token: TOKEN, fetch: page }).listForms())).toMatchObject({ name: "ApiError", status: 200, code: "bad_response" });
  });

  test("a cancel while the body is read keeps its own error", async () => {
    const controller = new AbortController();
    const half: typeof fetch = async () =>
      new Response(new ReadableStream({ start: (c) => void controller.signal.addEventListener("abort", () => c.error(controller.signal.reason)) }), { status: 200 });
    const pending = caught(createClient({ baseUrl, token: TOKEN, fetch: half }).listForms({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toMatchObject({ name: "AbortError" });
  });

  test("a CSV reply that is HTML is an ApiError", async () => {
    const page: typeof fetch = async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    expect(await caught(createClient({ baseUrl, token: TOKEN, fetch: page }).exportCsv("poll"))).toMatchObject({ code: "bad_response" });
  });

  test("a 429 keeps the retry-after seconds", async () => {
    const limited: typeof fetch = async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "17" } });
    expect(await caught(createClient({ baseUrl, fetch: limited }).submit("poll", {}))).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 17 });
  });

  test("an empty retry-after header gives no retryAfter", async () => {
    const limited: typeof fetch = async () => new Response("{}", { status: 429, headers: { "retry-after": " " } });
    expect(((await caught(createClient({ baseUrl, fetch: limited }).submit("poll", {}))) as ApiError).retryAfter).toBeUndefined();
  });

  test("a bad base URL or an empty token is refused", () => {
    expect(() => createClient({ baseUrl: "", token: "t" })).toThrow(TypeError);
    expect(() => createClient({ baseUrl, token: "" })).toThrow(TypeError);
    expect(() => createClient({ baseUrl: "forms.example.com", token: "t" })).toThrow(TypeError);
    expect(() => createClient({ baseUrl: "https://x.test/?a=1", token: "t" })).toThrow(TypeError);
    expect(() => createClient({ baseUrl: "https://u:p@x.test", token: "t" })).toThrow(TypeError);
    expect(() => createClient({ baseUrl: "https://x.test?", token: "t" })).toThrow(TypeError);
    expect(() => createClient({ baseUrl: "https://x.test#", token: "t" })).toThrow(TypeError);
  });
});
