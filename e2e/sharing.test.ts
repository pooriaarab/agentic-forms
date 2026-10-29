// Drives the built CLI and the real MCP server over stdio against a real Worker (wrangler dev, D1) to share a form.
// Run `npm run build` first (ci:local does).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { seed } from "./seed.js";

const ADA = "e2e-share-ada-token-0123456789-0123456789";
const BOB = "e2e-share-bob-token-0123456789-0123456789";
const RATE_SECRET = "e2e-rate-secret-0123456789-0123456789";
const PORT = 8891; // private to this file: the other e2e files use 8799 to 8870
const url = `http://127.0.0.1:${PORT}`;
const work = mkdtempSync(join(tmpdir(), "forms-share-"));
let proc: ChildProcess;
let mcp: Client;

const api = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${url}/api/v1/forms${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
const cli = (args: string[], token?: string) => {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (token) Object.assign(env, { AGENTIC_FORMS_URL: url, AGENTIC_FORMS_TOKEN: token });
  const run = spawnSync("node", [join(process.cwd(), "dist/cli.js"), "--data", join(work, "data.json"), ...args], { encoding: "utf8", env });
  return { code: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
};
const call = async (name: string, args: Record<string, unknown>) => {
  const result = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { error: result.isError === true, text: result.content[0]!.text };
};

beforeAll(async () => {
  const persist = mkdtempSync(join(tmpdir(), "forms-d1-"));
  seed(persist, ADA, undefined, "ada");
  seed(persist, BOB, undefined, "bob");
  proc = spawn("node_modules/.bin/wrangler", ["dev", "--local", "--ip", "127.0.0.1", "--port", String(PORT), "--inspector-port", "9341", "--persist-to", persist, "--var", "FORMS_REGION:unknown", "--var", "FORMS_UNSAFE_LOCAL_REGION:1", "--var", `FORMS_RATE_SECRET:${RATE_SECRET}`], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  let log = "";
  proc.stdout?.on("data", (d) => (log += d));
  proc.stderr?.on("data", (d) => (log += d));
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      await fetch(`${url}/health`, { headers: { connection: "close" } });
      break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`wrangler dev did not start:\n${log.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  expect((await api(ADA, "POST", "", { id: "poll", title: "Poll", sections: [{ id: "s", title: "S", questions: [] }] })).status).toBe(201);
});
afterAll(async () => {
  await mcp?.close();
  proc?.kill();
});

describe("sharing from the CLI", () => {
  test("it needs a Worker and a token, and says so with exit 2", () => {
    expect(cli(["share", "poll", "--subject", "bob", "--kind", "human", "--role", "viewer"]).code).toBe(2);
    expect(cli(["shares", "poll"]).err).toContain("needs a Worker");
    const noToken = spawnSync("node", ["dist/cli.js", "shares", "poll", "--url", url], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(noToken.status).toBe(2);
    expect(noToken.stderr).toContain("AGENTIC_FORMS_TOKEN");
  });

  test("bad flags exit 2 and send nothing", () => {
    expect(cli(["share", "poll", "--subject", "bob", "--kind", "robot", "--role", "viewer"], ADA).code).toBe(2);
    expect(cli(["share", "poll", "--subject", "bob", "--kind", "human", "--role", "boss"], ADA).code).toBe(2);
    expect(cli(["share", "poll", "--kind", "human", "--role", "viewer"], ADA).code).toBe(2);
    expect(cli(["share", "--subject", "bob", "--kind", "human", "--role", "viewer"], ADA).code).toBe(2);
  });

  test("share, list, and unshare change what bob can read", async () => {
    expect((await api(BOB, "GET", "/poll")).status).toBe(404);
    expect(JSON.parse(cli(["share", "poll", "--subject", "bob", "--kind", "human", "--role", "viewer"], ADA).out)).toEqual({ ok: true });
    expect((await api(BOB, "GET", "/poll")).status).toBe(200);
    const grants = JSON.parse(cli(["shares", "poll"], ADA).out).grants as { subjectId: string; subjectKind: string; role: string }[];
    expect(grants.map((g) => `${g.subjectKind}:${g.subjectId}:${g.role}`).sort()).toEqual(["human:ada:owner", "human:bob:viewer"]);
    expect(JSON.parse(cli(["unshare", "poll", "--subject", "bob", "--kind", "human"], ADA).out)).toEqual({ ok: true });
    expect((await api(BOB, "GET", "/poll")).status).toBe(404);
  });

  test("a refusal exits 1 with the code, and a non-owner cannot list or share", () => {
    const refused = cli(["shares", "poll"], BOB);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/^error: (not_found|forbidden)/);
    expect(cli(["share", "poll", "--subject", "bob", "--kind", "human", "--role", "owner"], BOB).code).toBe(1);
    const last = cli(["unshare", "poll", "--subject", "ada", "--kind", "human"], ADA);
    expect(last.code).toBe(1);
    expect(last.err).toContain("last owner");
  });

  test("invite, link, and unlink work, and a list shows no email and no token", () => {
    expect(cli(["invite", "poll", "--role", "viewer", "--email", "ada@example.com"]).code).toBe(2);
    const invite = cli(["invite", "poll", "--role", "viewer", "--email", "ada@example.com", "--expires-in-ms", "60000"], ADA);
    expect(invite.code).toBe(0);
    const link = JSON.parse(cli(["link", "poll", "--role", "viewer", "--signed-in-only"], ADA).out) as { id: string; token: string };
    expect(link.token).toBeTruthy();
    const invites = cli(["invites", "poll"], ADA).out;
    expect(JSON.parse(invites).invites).toHaveLength(1);
    expect(invites).not.toContain("example.com");
    const links = cli(["links", "poll"], ADA).out;
    expect(JSON.parse(links).links).toMatchObject([{ id: link.id, signedInOnly: true }]);
    expect(links).not.toContain(link.token);
    expect(cli(["links", "poll"], BOB).code).toBe(1);
    expect(cli(["link", "poll", "--role", "owner"], ADA).code).toBe(2);
    expect(cli(["invite", "poll", "--role", "viewer"], ADA).code).toBe(2);
    expect(cli(["unlink", "poll"], ADA).code).toBe(2);
    expect(JSON.parse(cli(["unlink", "poll", "--link", link.id], ADA).out)).toEqual({ ok: true });
    expect(cli(["unlink", "poll", "--link", "nope"], ADA).err).toContain("not_found");
  });

  test("--help lists the commands", () => {
    const help = cli(["--help"]).out;
    for (const word of ["share <id>", "shares <id>", "unshare <id>", "invite <id>", "link <id>", "unlink <id>", "create_link", "share_form", "--url"]) expect(help).toContain(word);
  });
});

describe("sharing from MCP", () => {
  test("a local server has no sharing tools", async () => {
    const local = new Client({ name: "e2e", version: "0.0.0" });
    await local.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js", "mcp"], env: { PATH: process.env.PATH ?? "", AGENTIC_FORMS_DATA: join(work, "local.json") } }));
    const names = (await local.listTools()).tools.map((t) => t.name);
    await local.close();
    expect(names).not.toContain("share_form");
  });

  test("a URL with no token keeps the local tools and drops the sharing tools", async () => {
    const half = new Client({ name: "e2e", version: "0.0.0" });
    await half.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js", "mcp"], env: { PATH: process.env.PATH ?? "", AGENTIC_FORMS_DATA: join(work, "half.json"), AGENTIC_FORMS_URL: url }, stderr: "ignore" }));
    const names = (await half.listTools()).tools.map((t) => t.name);
    await half.close();
    expect(names).toContain("new_form");
    expect(names).not.toContain("share_form");
  });

  test("with a Worker it has share_form, list_shares, and unshare_form", async () => {
    mcp = new Client({ name: "e2e", version: "0.0.0" });
    await mcp.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js", "mcp"], env: { PATH: process.env.PATH ?? "", AGENTIC_FORMS_DATA: join(work, "remote.json"), AGENTIC_FORMS_URL: url, AGENTIC_FORMS_TOKEN: ADA } }));
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["share_form", "list_shares", "unshare_form"]));

    expect(JSON.parse((await call("share_form", { form: "poll", subject: "bot", kind: "agent", role: "editor" })).text)).toEqual({ ok: true });
    const listed = JSON.parse((await call("list_shares", { form: "poll" })).text).grants as { subjectId: string; role: string }[];
    expect(listed.map((g) => `${g.subjectId}:${g.role}`).sort()).toEqual(["ada:owner", "bot:editor"]);
    expect(JSON.parse((await call("unshare_form", { form: "poll", subject: "bot", kind: "agent" })).text)).toEqual({ ok: true });
    expect(JSON.parse((await call("list_shares", { form: "poll" })).text).grants).toHaveLength(1);
  });

  test("it invites, makes and revokes links, and lists without secrets", async () => {
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_invite", "list_invites", "create_link", "list_links", "revoke_link"]));
    expect((await call("create_invite", { form: "poll", role: "editor", handle: "helper" })).error).toBe(false);
    expect(JSON.parse((await call("list_invites", { form: "poll" })).text).invites.some((i: { handle?: string }) => i.handle === "helper")).toBe(true);
    const link = JSON.parse((await call("create_link", { form: "poll", role: "viewer" })).text) as { id: string; token: string };
    const listed = (await call("list_links", { form: "poll" })).text;
    expect(listed).toContain(link.id);
    expect(listed).not.toContain(link.token);
    expect(JSON.parse((await call("revoke_link", { form: "poll", link: link.id })).text)).toEqual({ ok: true });
    expect((await call("create_link", { form: "poll", role: "owner" })).error).toBe(true);
    expect((await call("revoke_link", { form: "poll", link: "nope" })).text).toContain("not_found");
  });

  test("a refusal is a tool error with the code", async () => {
    const bad = await call("share_form", { form: "ghost", subject: "bob", kind: "human", role: "viewer" });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/not_found|forbidden/);
    expect((await call("unshare_form", { form: "poll", subject: "ada", kind: "human" })).error).toBe(true);
  });
});
