// Several writers on one data file: real CLI processes, a real MCP server over
// stdio, and two store instances in one process. Written before the lock code.
// Run `npm run build` first (ci:local does).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createFileStore } from "../src/core/file-store.js";

const dir = () => mkdtempSync(join(tmpdir(), "forms-lock-"));
const env = (data: string) => ({ ...(process.env as Record<string, string>), AGENTIC_FORMS_DATA: data });
const cliSync = (data: string, args: string[]) => spawnSync("node", ["dist/cli.js", ...args], { encoding: "utf8", env: env(data) });
const cliAsync = (data: string, args: string[]) =>
  new Promise<{ code: number | null; err: string }>((resolve) => {
    const proc = spawn("node", ["dist/cli.js", ...args], { env: env(data) });
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) => resolve({ code, err }));
  });
const rows = (data: string, form = "poll") => {
  const out = JSON.parse(cliSync(data, ["responses", form, "--limit", "500"]).stdout) as { items: { values: { n: string } }[] };
  return out.items.map((r) => r.values.n).sort();
};
function seed(data: string) {
  cliSync(data, ["new", "poll", "--title", "Poll"]);
  cliSync(data, ["add-question", "poll", "--id", "n", "--type", "short_text", "--label", "N"]);
  cliSync(data, ["publish", "poll"]);
}
const submit = (data: string, n: string) => cliAsync(data, ["submit", "poll", "--answers", JSON.stringify({ n })]);

describe("parallel writers lose nothing", () => {
  test("12 CLI processes and a running MCP server all land their rows", async () => {
    const data = join(dir(), "data.json");
    seed(data);
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js", "mcp"], env: env(data) }));
    try {
      // The MCP process now holds its own copy of the file from before the CLI writes.
      const viaMcp = Array.from({ length: 6 }, (_, i) => client.callTool({ name: "submit_response", arguments: { form: "poll", answers: { n: `m${i}` } } }));
      const viaCli = Array.from({ length: 12 }, (_, i) => submit(data, `c${i}`));
      const results = await Promise.all(viaCli);
      await Promise.all(viaMcp);
      expect(results.map((r) => r.code), results.map((r) => r.err).join("|")).toEqual(Array(12).fill(0));
      const expected = [...Array.from({ length: 12 }, (_, i) => `c${i}`), ...Array.from({ length: 6 }, (_, i) => `m${i}`)].sort();
      expect(rows(data)).toEqual(expected);
    } finally {
      await client.close();
    }
  });

  test("a form saved by a CLI is visible to a running MCP server", async () => {
    const data = join(dir(), "data.json");
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js", "mcp"], env: env(data) }));
    try {
      seed(data);
      const got = (await client.callTool({ name: "get_form", arguments: { form: "poll" } })) as { isError?: boolean };
      expect(got.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });

  test("two store instances on one file, written at the same time, keep every doc", async () => {
    const path = join(dir(), "data.json");
    const a = createFileStore(path);
    const b = createFileStore(path);
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).put("things", `t${i}`, { i })));
    const fresh = await createFileStore(path).query("things");
    expect(fresh.items.map((e) => e.id).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `t${i}`).sort());
  });

  test("no temp file or lock is left behind", async () => {
    const d = dir();
    const data = join(d, "data.json");
    seed(data);
    await Promise.all([submit(data, "x"), submit(data, "y")]);
    expect(readdirSync(d)).toEqual(["data.json"]);
  });
});

describe("a lock left by a crash", () => {
  const deadPid = () => {
    const proc = spawnSync("node", ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    return Number(proc.stdout);
  };
  const lockPath = (data: string) => `${data}.lock`;
  const age = (path: string, seconds: number) => {
    const t = new Date(Date.now() - seconds * 1000);
    utimesSync(path, t, t);
  };

  test("a lock held by a dead process is taken over", async () => {
    const data = join(dir(), "data.json");
    seed(data);
    writeFileSync(lockPath(data), `${deadPid()}:${Date.now()}:token`);
    const started = Date.now();
    expect((await submit(data, "a")).code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(rows(data)).toEqual(["a"]);
  });

  test("an old lock held by a live process is taken over", async () => {
    const data = join(dir(), "data.json");
    seed(data);
    writeFileSync(lockPath(data), `${process.pid}:${Date.now()}:token`);
    age(lockPath(data), 120);
    expect((await submit(data, "b")).code).toBe(0);
    expect(rows(data)).toEqual(["b"]);
  });

  test("an old lock with unreadable content is taken over", async () => {
    const data = join(dir(), "data.json");
    seed(data);
    writeFileSync(lockPath(data), "\u0000garbage");
    age(lockPath(data), 120);
    expect((await submit(data, "c")).code).toBe(0);
    expect(rows(data)).toEqual(["c"]);
  });

  test("a fresh lock held by a live process is respected until it is released", async () => {
    const data = join(dir(), "data.json");
    seed(data);
    writeFileSync(lockPath(data), `${process.pid}:${Date.now()}:token`);
    const started = Date.now();
    const pending = submit(data, "d");
    await new Promise((r) => setTimeout(r, 1_200));
    expect(rows(data)).toEqual([]); // the writer is still waiting
    rmSync(lockPath(data));
    expect((await pending).code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_200);
    expect(rows(data)).toEqual(["d"]);
  });

  test("a fresh lock with unreadable content counts as live", async () => {
    const data = join(dir(), "data.json");
    seed(data);
    writeFileSync(lockPath(data), "\u0000garbage");
    const pending = submit(data, "e");
    await new Promise((r) => setTimeout(r, 1_200));
    expect(existsSync(lockPath(data))).toBe(true);
    expect(rows(data)).toEqual([]);
    rmSync(lockPath(data));
    expect((await pending).code).toBe(0);
  });

  test("a damaged data file is an error, not an empty store", () => {
    const data = join(dir(), "data.json");
    seed(data);
    writeFileSync(data, "{not json");
    const run = cliSync(data, ["responses", "poll"]);
    expect(run.status).not.toBe(0);
    expect(readFileSync(data, "utf8")).toBe("{not json");
  });
});
