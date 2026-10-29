// Drives the built CLI as a real process. Run `npm run build` first (ci:local does).
import { mkdtempSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createFileStore } from "../src/core/file-store.js";

const data = join(mkdtempSync(join(tmpdir(), "forms-cli-")), "data.json");
const cli = (args: string[], input?: string) => {
  const run = spawnSync("node", ["dist/cli.js", "--data", data, ...args], { encoding: "utf8", input });
  return { code: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
};
const json = (text: string) => JSON.parse(text);

const cycle = { id: "loop", title: "Loop", sections: [{ id: "s", title: "S", questions: [
  { id: "a", type: "short_text", label: "A", showIf: { question: "b", op: "answered" } },
  { id: "b", type: "short_text", label: "B", showIf: { question: "a", op: "answered" } },
] }] };

describe("cli failures", () => {
  test("an unknown command or a missing form id exits 2", () => {
    expect(cli(["frobnicate"]).code).toBe(2);
    expect(cli(["publish"]).code).toBe(2);
  });

  test("a missing form exits 1 with a plain message", () => {
    const run = cli(["add-question", "nope", "--id", "q", "--type", "short_text", "--label", "Q"]);
    expect(run).toMatchObject({ code: 1 });
    expect(run.err).toContain('form "nope" not found');
  });

  test("a bad question type exits 1 and changes nothing", () => {
    cli(["new", "bad", "--title", "Bad"]);
    expect(cli(["add-question", "bad", "--id", "q", "--type", "telepathy", "--label", "Q"]).code).toBe(1);
    expect(json(cli(["show", "bad"]).out).sections[0].questions).toEqual([]);
  });

  test("a spec with a logic cycle exits 1 and stores nothing", () => {
    const run = cli(["from-prompt", "--spec", "-"], JSON.stringify(cycle));
    expect(run.code).toBe(1);
    expect(run.err).toContain("loops");
    expect(cli(["show", "loop"]).code).toBe(1);
  });

  test("a second form with the same id exits 1", () => {
    expect(cli(["new", "bad", "--title", "Again"]).code).toBe(1);
  });
});

describe("cli purge-all", () => {
  test("it deletes expired rows in every form and keeps the rest", async () => {
    const store = createFileStore(data);
    const old = { formId: "any", formVersion: 1, submittedAt: "2020-01-01T00:00:00.000Z", values: {} };
    await store.put("responses", "old-a", { ...old, retainUntil: "2020-02-01T00:00:00.000Z" });
    await store.put("responses", "old-b", { ...old, formId: "other", retainUntil: "2020-03-01T00:00:00.000Z" });
    await store.put("responses", "keep", { ...old, retainUntil: "2999-01-01T00:00:00.000Z" });
    expect(json(cli(["purge-all"]).out)).toEqual({ purged: 2, rateLimits: 0 });
    expect((await store.query("responses")).items.map((i) => i.id)).toEqual(["keep"]);
    expect(json(cli(["purge-all"]).out)).toEqual({ purged: 0, rateLimits: 0 });
  });
});

describe("cli backfill-owners", () => {
  test("it gives forms an owner once, and a second run changes nothing", async () => {
    cli(["new", "old-form", "--title", "Old"]);
    const first = json(cli(["backfill-owners", "--owner", "olga"]).out);
    expect(first.created).toContain("old-form");
    expect((await createFileStore(data).get("grants", "old-form:human:olga"))?.role).toBe("owner");
    expect(json(cli(["backfill-owners", "--owner", "olga"]).out).created).toEqual([]);
    expect(cli(["backfill-owners"]).code).toBe(2);
    expect(cli(["backfill-owners", "--owner", "a b"]).code).toBe(1);
  });
});

describe("cli flow", () => {
  test("new, add-question, publish, submit, responses, export", () => {
    expect(json(cli(["new", "poll", "--title", "Poll", "--retention-days", "30"]).out)).toMatchObject({ version: 1, status: "draft" });
    cli(["add-question", "poll", "--id", "color", "--type", "single_choice", "--label", "Color", "--required", "--choices", "red,blue"]);
    cli(["add-question", "poll", "--id", "why", "--type", "long_text", "--label", "Why", "--required", "--show-if", "color:equals:red"]);
    const edit = { title: "Poll 2", sections: [{ id: "main", title: "Poll", questions: [{ id: "color", type: "single_choice", label: "Color", required: true, choices: ["red", "blue"] }, { id: "why", type: "long_text", label: "Why", required: true, showIf: { question: "color", op: "equals", value: "red" } }] }] };
    expect(json(cli(["update", "poll", "--spec", "-"], JSON.stringify(edit)).out)).toMatchObject({ title: "Poll 2" });
    expect(cli(["update", "poll"]).code).toBe(2);
    expect(cli(["submit", "poll", "--answers", '{"color":"red"}']).code).toBe(1); // draft is not open
    expect(json(cli(["publish", "poll"]).out).status).toBe("published");
    expect(cli(["submit", "poll", "--answers", '{"color":"red"}']).err).toContain("why");
    expect(cli(["submit", "poll", "--answers", '{"color":"blue"}']).code).toBe(0);
    expect(cli(["submit", "poll", "--answers", '{"color":"red","why":"warm, \\"bold\\""}']).code).toBe(0);
    expect(json(cli(["responses", "poll", "--limit", "1"]).out)).toMatchObject({ items: [{ values: { color: "blue" } }] });
    const lines = cli(["export", "poll"]).out.split("\n");
    expect(lines[0]).toBe("response_id,submitted_at,form_version,color,why");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('"warm, ""bold"""');
  });

  test("from-prompt takes a JSON spec on stdin and can publish it", () => {
    const spec = { id: "quick", title: "Quick", sections: [{ id: "s", title: "S", questions: [{ id: "n", type: "number", label: "N", required: true, rules: { min: 1 } }] }] };
    expect(json(cli(["from-prompt", "--spec", "-", "--publish"], JSON.stringify(spec)).out).status).toBe("published");
    expect(cli(["submit", "quick", "--answers", '{"n":0}']).code).toBe(1);
    expect(cli(["submit", "quick", "--answers", '{"n":2}']).code).toBe(0);
  });

  test("the data file is private to the user", () => {
    expect(statSync(data).mode & 0o077).toBe(0);
  });
});
