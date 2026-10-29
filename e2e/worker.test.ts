// Runs the Worker under `wrangler dev`, drives /api/v1 over HTTP, then fills in the
// public page with jsdom (it runs the page's own script) and reads the row back.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const TOKEN = "e2e-token-0123456789-0123456789-abcdef"; // 40 bytes
const PORT = 8799;
const base = `http://127.0.0.1:${PORT}`;
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const running: ChildProcess[] = [];

// Starts `wrangler dev` and waits until it answers any request. A Worker that
// refuses to start answers 500, so readiness is "any HTTP status".
async function start(port: number, token?: string, options: { persist?: string; vars?: string[]; scheduled?: boolean } = {}): Promise<ChildProcess> {
  const vars = [...(token === undefined ? [] : ["--var", `FORMS_API_TOKEN:${token}`]), ...(options.vars ?? []).flatMap((v) => ["--var", v])];
  const proc = spawn("node_modules/.bin/wrangler", ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), ...(options.scheduled ? ["--test-scheduled"] : []), "--persist-to", options.persist ?? mkdtempSync(join(tmpdir(), "forms-d1-")), ...vars], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  running.push(proc);
  let log = "";
  proc.stdout?.on("data", (d) => (log += d));
  proc.stderr?.on("data", (d) => (log += d));
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      return proc;
    } catch {}
    if (Date.now() > deadline) throw new Error(`wrangler dev did not start:\n${log.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(() => start(PORT, TOKEN));
afterAll(() => running.forEach((proc) => proc.kill()));

const api = (path: string, body?: unknown, headers: Record<string, string> = auth) =>
  fetch(`${base}/api/v1/forms${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });

const spec = {
  id: "visit",
  title: "Visit survey",
  notice: "We keep your answers to improve the visit.",
  retentionDays: 30,
  publish: true,
  sections: [{ id: "s", title: "Your visit", questions: [
    { id: "name", type: "short_text", label: "Name", required: true },
    { id: "color", type: "single_choice", label: "Favorite color", required: true, choices: ["red", "blue"] },
    { id: "why", type: "long_text", label: "Why red", required: true, showIf: { question: "color", op: "equals", value: "red" } },
  ] }],
};

describe("secret failures", () => {
  const routes: [string, string][] = [
    ["GET", "/api/v1/forms"],
    ["POST", "/api/v1/forms"],
    ["GET", "/api/v1/forms/x"],
    ["GET", "/api/v1/forms/x/responses"],
    ["GET", "/api/v1/forms/x/export"],
  ];

  test("a Worker with no token answers 503 on every /api/v1 route", async () => {
    await start(8800);
    for (const [method, path] of routes) {
      for (const headers of [{}, { authorization: "Bearer anything" }, { authorization: "Bearer " }] as Record<string, string>[]) {
        const res = await fetch(`http://127.0.0.1:8800${path}`, { method, headers, body: method === "POST" ? "{}" : undefined });
        expect(res.status, `${method} ${path}`).toBe(503);
      }
    }
    expect((await fetch("http://127.0.0.1:8800/health")).status).toBe(200);
  });

  test("a token under 32 bytes makes the Worker refuse to serve", async () => {
    await start(8801, "a".repeat(31));
    for (const path of ["/health", "/api/v1/forms", "/f/x"]) {
      const res = await fetch(`http://127.0.0.1:8801${path}`, { headers: { authorization: `Bearer ${"a".repeat(31)}` } });
      expect(res.status, path).toBe(500);
    }
  });

  test("a token of exactly 32 bytes is accepted", async () => {
    await start(8802, "b".repeat(32));
    const res = await fetch("http://127.0.0.1:8802/api/v1/forms", { headers: { authorization: `Bearer ${"b".repeat(32)}` } });
    expect(res.status).toBe(200);
  });
});

describe("durable storage", () => {
  const stop = (proc: ChildProcess) => new Promise((resolve) => (proc.once("exit", resolve), proc.kill()));

  test("a form and its rows survive a Worker restart", async () => {
    const persist = mkdtempSync(join(tmpdir(), "forms-d1-"));
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const first = await start(8803, TOKEN, { persist });
    const open = { id: "keep", title: "Keep", publish: true, sections: [{ id: "s", title: "S", questions: [{ id: "n", type: "short_text", label: "N", required: true }] }] };
    expect((await fetch("http://127.0.0.1:8803/api/v1/forms", { method: "POST", headers, body: JSON.stringify(open) })).status).toBe(201);
    expect((await fetch("http://127.0.0.1:8803/f/keep", { method: "POST", headers, body: JSON.stringify({ answers: { n: "kept" } }) })).status).toBe(201);
    await stop(first);

    await start(8804, TOKEN, { persist });
    const rows = await (await fetch("http://127.0.0.1:8804/api/v1/forms/keep/responses", { headers })).json();
    expect(rows.items.map((r: { values: { n: string } }) => r.values.n)).toEqual(["kept"]);
  });

  test("a region that is not eu or us makes the Worker refuse to serve", async () => {
    for (const [i, region] of ["mars", "unknown"].entries()) {
      await start(8805 + i, TOKEN, { vars: [`FORMS_REGION:${region}`] });
      expect((await fetch(`http://127.0.0.1:${8805 + i}/health`)).status, region).toBe(500);
    }
  });
});

describe("scheduled purge", () => {
  const persist = mkdtempSync(join(tmpdir(), "forms-d1-"));
  const sql = (command: string) =>
    JSON.parse(
      execFileSync("node_modules/.bin/wrangler", ["d1", "execute", "DB", "--local", "--persist-to", persist, "--json", "--command", command], {
        encoding: "utf8",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
      }),
    )[0].results as Record<string, unknown>[];
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const ids = (collection: string) => sql(`SELECT id FROM store_docs WHERE collection = '${collection}' ORDER BY id`).map((r) => r.id);
  const row = (id: string, retainUntil: string) =>
    JSON.stringify({ id, formId: "purge", formVersion: 1, submittedAt: "2020-01-01T00:00:00.000Z", values: { n: id }, retainUntil });

  test("the Cron Trigger hard-deletes expired rows and keeps the rest", async () => {
    const port = 8810;
    await start(port, TOKEN, { persist, scheduled: true });
    const open = { id: "purge", title: "Purge", retentionDays: 30, publish: true, sections: [{ id: "s", title: "S", questions: [{ id: "n", type: "short_text", label: "N", required: true }] }] };
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/forms`, { method: "POST", headers, body: JSON.stringify(open) })).status).toBe(201);
    expect((await fetch(`http://127.0.0.1:${port}/f/purge`, { method: "POST", headers, body: JSON.stringify({ answers: { n: "live" } }) })).status).toBe(201);
    const [live] = ids("responses") as string[];

    // Old rows, made directly in the database: one expired, one with a date that is not a time.
    const insert = (id: string, body: string) => sql(`INSERT INTO store_docs (collection, id, body) VALUES ('responses', '${id}', '${body}')`);
    insert("old-1", row("old-1", "2020-02-01T00:00:00.000Z"));
    insert("old-2", row("old-2", "not a date"));
    sql(`INSERT INTO store_docs (collection, id, body) VALUES ('rate_limits', 'finished', '{"start":0,"count":1,"windowMs":60000}')`);
    expect(ids("responses")).toEqual([live, "old-1", "old-2"].sort());
    const before = await (await fetch(`http://127.0.0.1:${port}/api/v1/forms/purge/responses`, { headers })).json();
    expect(before.items).toHaveLength(1); // the read-time filter already hides them

    // Run the job the way the platform does.
    const run = await fetch(`http://127.0.0.1:${port}/__scheduled?cron=17+*+*+*+*`);
    expect(run.status).toBe(200);

    expect(ids("responses")).toEqual([live]); // gone from storage, not only hidden
    expect(ids("rate_limits")).not.toContain("finished");
    const after = await (await fetch(`http://127.0.0.1:${port}/api/v1/forms/purge/responses`, { headers })).json();
    expect(after.items.map((r: { values: { n: string } }) => r.values.n)).toEqual(["live"]);
  });
});

describe("api failures", () => {
  test("no token or a wrong token is 401", async () => {
    expect((await api("", undefined, {})).status).toBe(401);
    expect((await api("", undefined, { authorization: "Bearer nope" })).status).toBe(401);
  });

  test("a bad spec is 400 and a missing form is 404", async () => {
    expect((await api("", { id: "x", title: "X", sections: [], extra: 1 })).status).toBe(400);
    expect((await api("/ghost/responses")).status).toBe(404);
    expect((await api("", "{nope" as unknown)).status).toBe(400);
  });

  test("an unpublished form has no public page", async () => {
    await api("", { id: "draft", title: "Draft", sections: [{ id: "s", title: "S", questions: [] }] });
    expect((await fetch(`${base}/f/draft`)).status).toBe(404);
  });
});

describe("public page", () => {
  test("a respondent fills the page and the answer lands as a row", async () => {
    expect((await api("", spec)).status).toBe(201);
    expect((await api("", spec)).status).toBe(409);

    const page = await fetch(`${base}/f/visit`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");

    const dom = await JSDOM.fromURL(`${base}/f/visit`, {
      runScripts: "dangerously",
      beforeParse(window) {
        (window as unknown as { fetch: typeof fetch }).fetch = (url, init) => fetch(new URL(String(url), base), init);
      },
    });
    const doc = dom.window.document;
    const wrapper = (n: number) => doc.querySelector(`[data-q="0-${n}"]`) as HTMLElement;
    const fire = (el: Element, type: string) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
    expect(wrapper(2).hidden).toBe(true); // "Why red" starts hidden

    (doc.getElementById("q-0") as HTMLInputElement).value = "Ada";
    const red = doc.querySelector('input[name="color"][value="red"]') as HTMLInputElement;
    red.checked = true;
    fire(red, "change");
    expect(wrapper(2).hidden).toBe(false); // red shows it
    const blue = doc.querySelector('input[name="color"][value="blue"]') as HTMLInputElement;
    blue.checked = true;
    fire(blue, "change");
    expect(wrapper(2).hidden).toBe(true); // blue hides it, and it no longer blocks the submit

    (doc.getElementById("consent") as HTMLInputElement).checked = true;
    (doc.getElementById("form") as HTMLFormElement).requestSubmit();
    for (let i = 0; i < 50 && (doc.getElementById("done") as HTMLElement).hidden; i++) await new Promise((r) => setTimeout(r, 100));
    expect((doc.getElementById("done") as HTMLElement).hidden).toBe(false);

    const rows = await (await api("/visit/responses")).json();
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]).toMatchObject({ formVersion: 1, consent: true, values: { name: "Ada", color: "blue" } });
    expect(rows.items[0].retainUntil).toBeTruthy();
    const csv = await (await api("/visit/export")).text();
    expect(csv.split("\n")[0]).toBe("response_id,submitted_at,form_version,name,color,why");
  });

  test("a submit without consent is refused by the Worker", async () => {
    const res = await fetch(`${base}/f/visit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: { name: "Bo", color: "blue" } }) });
    expect(res.status).toBe(422);
    expect((await (await api("/visit/responses")).json()).items).toHaveLength(1);
  });
});
