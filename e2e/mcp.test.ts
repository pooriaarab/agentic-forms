// Drives the real MCP server over stdio: `agentic-forms mcp` as a child process.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

let client: Client;
const call = async (name: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { error: result.isError === true, text: result.content[0].text };
};
const spec = (id: string, questions: unknown[]) => ({ id, title: id, sections: [{ id: "s", title: "S", questions }] });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "forms-mcp-"));
  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: "node",
    args: ["dist/cli.js", "mcp"],
    env: { ...(process.env as Record<string, string>), AGENTIC_FORMS_DATA: join(dir, "data.json") },
  }));
});
afterAll(() => client.close());

describe("mcp over stdio", () => {
  test("lists the tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["add_question", "export_csv", "get_form", "list_responses", "new_form", "publish_form", "purge_all", "purge_expired", "submit_response"]);
  });

  test("a logic cycle, a duplicate id, a bad type, and a missing form are tool errors, not crashes", async () => {
    const loop = [
      { id: "a", type: "short_text", label: "A", showIf: { question: "b", op: "answered" } },
      { id: "b", type: "short_text", label: "B", showIf: { question: "a", op: "answered" } },
    ];
    expect((await call("new_form", spec("loop", loop))).error).toBe(true);
    expect((await call("get_form", { form: "loop" })).error).toBe(true);
    expect((await call("add_question", { form: "ghost", question: { id: "q", type: "short_text", label: "Q" } })).error).toBe(true);
    expect((await call("new_form", spec("x", [{ id: "q", type: "telepathy", label: "Q" }]))).error).toBe(true);
    await call("new_form", spec("dup", []));
    expect((await call("new_form", spec("dup", []))).text).toContain("already exists");
  });

  test("make, extend, publish, submit, list, export", async () => {
    expect((await call("new_form", { ...spec("survey", [{ id: "name", type: "short_text", label: "Name", required: true }]), notice: "We store your name." })).error).toBe(false);
    expect((await call("add_question", { form: "survey", question: { id: "mood", type: "rating", label: "Mood" } })).error).toBe(false);
    expect((await call("publish_form", { form: "survey" })).error).toBe(false);
    expect((await call("submit_response", { form: "survey", answers: { name: "Ada" } })).text).toContain("consent");
    expect((await call("submit_response", { form: "survey", answers: { name: "Ada", mood: 4 }, consent: true })).error).toBe(false);
    expect((await call("submit_response", { form: "survey", answers: { mood: 9, name: "Bo" }, consent: true })).error).toBe(true);
    const rows = JSON.parse((await call("list_responses", { form: "survey" })).text);
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]).toMatchObject({ values: { name: "Ada", mood: 4 }, consent: true });
    expect((await call("export_csv", { form: "survey" })).text.split("\n")[0]).toBe("response_id,submitted_at,form_version,name,mood");
  });
});
