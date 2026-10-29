// Ways responses, versions, and CSV export can fail. Written before the code.
import { describe, expect, test } from "vitest";
import type { Form, Question } from "./form.js";
import { createFormRepo } from "./repo.js";
import { SubmitError, createResponses, toCsv } from "./responses.js";
import { createMemoryStore } from "agentic-identity";
import { validateForm } from "./form.js";

const q = (id: string, extra: Partial<Question> = {}): Question => ({ id, type: "short_text", label: id, required: false, ...extra });
const form = (questions: Question[]): Form => ({
  id: "f",
  title: "F",
  version: 1,
  status: "draft",
  sections: [{ id: "s", title: "S", questions }],
});
const colors = () => q("color", { type: "single_choice", choices: ["red", "blue"] });

function setup() {
  const store = createMemoryStore();
  const repo = createFormRepo(store);
  return { repo, responses: createResponses(store, repo) };
}

describe("submit failures", () => {
  test("a draft form takes no answers", async () => {
    const { repo, responses } = setup();
    await repo.save(form([q("a")]));
    await expect(responses.submit("f", { a: "x" })).rejects.toThrow("not published");
    await expect(responses.submit("missing", {})).rejects.toThrow("not published");
  });

  test("invalid answers are refused and nothing is stored", async () => {
    const { repo, responses } = setup();
    await repo.save(form([q("a", { required: true })]));
    await repo.publish("f");
    await expect(responses.submit("f", {})).rejects.toBeInstanceOf(SubmitError);
    expect((await responses.list("f")).items).toEqual([]);
  });

  test("publishing twice is refused", async () => {
    const { repo } = setup();
    await repo.save(form([q("a")]));
    await repo.publish("f");
    await expect(repo.publish("f")).rejects.toThrow("already published");
  });
});

describe("versions keep old responses readable", () => {
  test("an edit makes a new draft version and the old one keeps taking answers", async () => {
    const { repo, responses } = setup();
    await repo.save(form([colors()]));
    await repo.publish("f");
    await responses.submit("f", { color: "blue" });
    const edited = await repo.save(form([q("color", { type: "single_choice", choices: ["red"] })]));
    expect(edited).toMatchObject({ version: 2, status: "draft" });
    // The draft is not live. Version 1 still takes "blue".
    await responses.submit("f", { color: "blue" });
    await repo.publish("f");
    await expect(responses.submit("f", { color: "blue" })).rejects.toBeInstanceOf(SubmitError);
    const rows = (await responses.list("f")).items.map((r) => r.data);
    expect(rows.map((r) => r.formVersion)).toEqual([1, 1]);
    expect((await repo.getVersion("f", 1))?.sections[0].questions[0].choices).toEqual(["red", "blue"]);
  });

  test("a removed question stays a column in the export", async () => {
    const { repo, responses } = setup();
    await repo.save(form([q("old"), q("keep")]));
    await repo.publish("f");
    await responses.submit("f", { old: "o", keep: "k" }, { now: () => 1_000 });
    await repo.save(form([q("keep"), q("added")]));
    await repo.publish("f");
    await responses.submit("f", { keep: "k2", added: "n" }, { now: () => 2_000 });
    const lines = (await responses.exportCsv("f")).trim().split("\n");
    expect(lines[0]).toBe("response_id,submitted_at,form_version,keep,added,old");
    expect(lines[1].split(",").slice(2)).toEqual(["1", "k", "", "o"]);
    expect(lines[2].split(",").slice(2)).toEqual(["2", "k2", "n", ""]);
  });
});

describe("rows and listing", () => {
  test("a response is a flat row keyed by question id", async () => {
    const { repo, responses } = setup();
    await repo.save(form([q("a"), q("m", { type: "multi_choice", choices: ["x", "y"] })]));
    await repo.publish("f");
    const row = await responses.submit("f", { a: "hi", m: ["x", "y"] }, { now: () => Date.parse("2026-10-28T10:00:00Z") });
    expect(row).toMatchObject({ formId: "f", formVersion: 1, submittedAt: "2026-10-28T10:00:00.000Z", values: { a: "hi", m: ["x", "y"] } });
  });

  test("responses of another form never mix in", async () => {
    const { repo, responses } = setup();
    await repo.save(form([q("a")]));
    await repo.publish("f");
    await repo.save({ ...form([q("a")]), id: "g" });
    await repo.publish("g");
    await responses.submit("g", { a: "other" });
    expect((await responses.list("f")).items).toEqual([]);
  });

  test("paging walks every response once", async () => {
    const { repo, responses } = setup();
    await repo.save(form([q("a")]));
    await repo.publish("f");
    for (let i = 0; i < 25; i++) await responses.submit("f", { a: String(i) }, { now: () => 1_000 + i });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await responses.list("f", { limit: 10, cursor });
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(25);
  });
});

describe("csv safety", () => {
  test("quotes, commas, and newlines are escaped", () => {
    expect(toCsv([["a,b", 'say "hi"', "line\nbreak"]])).toBe('"a,b","say ""hi""","line\nbreak"\n');
  });

  test("a formula cell is made inert", () => {
    expect(toCsv([["=SUM(A1)", "+1", "-1", "@x", "\tx"]])).toBe("'=SUM(A1),'+1,'-1,'@x,'\tx\n");
  });

  test("a negative number stays a number", () => {
    expect(toCsv([[-5, 3, true]])).toBe("-5,3,true\n");
  });
});

describe("export failures", () => {
  test("a missing snapshot is a named error, not a TypeError", async () => {
    const store = createMemoryStore();
    const repo = createFormRepo(store);
    const responses = createResponses(store, repo);
    await repo.save(form([q("a")]));
    await repo.publish("f");
    await responses.submit("f", { a: "x" });
    await store.delete("form_versions", "f@1");
    await expect(responses.exportCsv("f")).rejects.toThrow('snapshot "f@1" is missing');
  });

  test("a question id that would repeat a fixed column is refused", () => {
    for (const id of ["response_id", "submitted_at", "form_version"]) {
      expect(validateForm(form([q(id)])).map((i) => i.code)).toEqual(["reserved_id"]);
    }
  });
});
