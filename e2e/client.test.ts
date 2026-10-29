// Drives the remote client against the real Worker under `wrangler dev`.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ApiError, createClient } from "../src/client.js";

const TOKEN = "e2e-client-token-0123456789-0123456789";
const RATE_SECRET = "e2e-rate-secret-0123456789-0123456789";
const PORT = 8830;
const baseUrl = `http://127.0.0.1:${PORT}`;
// Close each connection, as the Worker e2e does, so an idle socket is never reused.
const fetchClose: typeof fetch = (input, init) => fetch(input, { ...init, headers: { connection: "close", ...(init?.headers as Record<string, string> | undefined) } });
let proc: ChildProcess;

beforeAll(async () => {
  proc = spawn("node_modules/.bin/wrangler", ["dev", "--local", "--ip", "127.0.0.1", "--port", String(PORT), "--persist-to", mkdtempSync(join(tmpdir(), "forms-d1-")), "--var", "FORMS_REGION:unknown", "--var", "FORMS_UNSAFE_LOCAL_REGION:1", "--var", `FORMS_RATE_SECRET:${RATE_SECRET}`, "--var", `FORMS_API_TOKEN:${TOKEN}`], {
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
    await api.addQuestion("poll", { id: "note", type: "short_text", label: "Note" });
    expect((await api.publishForm("poll")).status).toBe("published");
    expect((await api.getForm("poll")).sections[0]!.questions.map((q) => q.id)).toEqual(["color", "note"]);
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
    expect((await api.exportCsv("poll")).split("\n")[0]).toBe("response_id,submitted_at,form_version,color,note");
    expect(await api.purge("poll")).toEqual({ purged: 0 });

    await api.share("poll", { subject: "ada", kind: "human", role: "viewer" });
    await api.revokeShare("poll", "ada", "human");
    expect((await api.listAudit("poll")).entries.length).toBeGreaterThan(0);
    expect(await api.purgeAll()).toMatchObject({ purged: 0 });
    expect(await api.backfillOwners("ada")).toMatchObject({ skipped: expect.any(Number) });
    await api.migrateGrants();

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

  test("a failed call is never retried", async () => {
    let calls = 0;
    const counting: typeof fetch = (input, init) => (calls++, fetchClose(input, init));
    await caught(createClient({ baseUrl, token: TOKEN, fetch: counting }).createForm({ id: "x" } as never));
    expect(calls).toBe(1);
  });
});

test("the client needs a base URL and a token", () => {
  expect(() => createClient({ baseUrl: "", token: "t" })).toThrow(TypeError);
  expect(() => createClient({ baseUrl, token: "" })).toThrow(TypeError);
});
