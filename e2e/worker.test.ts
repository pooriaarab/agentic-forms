// Runs the Worker under `wrangler dev`, drives /api/v1 over HTTP, then fills in the
// public page with jsdom (it runs the page's own script) and reads the row back.
import { spawn, type ChildProcess } from "node:child_process";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const TOKEN = "e2e-token-0123456789-0123456789-abcdef"; // 40 bytes
const PORT = 8799;
const base = `http://127.0.0.1:${PORT}`;
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const running: ChildProcess[] = [];

// Starts `wrangler dev` and waits until it answers any request. A Worker that
// refuses to start answers 500, so readiness is "any HTTP status".
async function start(port: number, token?: string): Promise<void> {
  const vars = token === undefined ? [] : ["--var", `FORMS_API_TOKEN:${token}`];
  const proc = spawn("node_modules/.bin/wrangler", ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), ...vars], {
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
      return;
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
