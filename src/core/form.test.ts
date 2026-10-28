// Written before the code. Each test names one way the logic or the
// validation can fail.
import { describe, expect, test } from "vitest";
import { validateAnswers, validateForm, visibleQuestions, type Form, type Question } from "./form.js";

const q = (id: string, extra: Partial<Question> = {}): Question => ({
  id,
  type: "short_text",
  label: id,
  required: false,
  ...extra,
});

const form = (questions: Question[], sections?: Form["sections"]): Form => ({
  id: "f1",
  title: "Survey",
  version: 1,
  status: "draft",
  sections: sections ?? [{ id: "s1", title: "One", questions }],
});

const codes = (f: Form) => validateForm(f).map((issue) => issue.code);

describe("form logic failures", () => {
  test("two questions that show each other are a cycle", () => {
    const f = form([
      q("a", { showIf: { question: "b", op: "answered" } }),
      q("b", { showIf: { question: "a", op: "answered" } }),
    ]);
    expect(codes(f)).toContain("logic_cycle");
  });

  test("a question that shows itself is a cycle", () => {
    expect(codes(form([q("a", { showIf: { question: "a", op: "answered" } })]))).toContain("logic_cycle");
  });

  test("a section that depends on its own question is a cycle", () => {
    const f = form([], [
      { id: "s1", title: "One", showIf: { question: "a", op: "answered" }, questions: [q("a")] },
    ]);
    expect(codes(f)).toContain("logic_cycle");
  });

  test("logic that points at a later question is rejected", () => {
    const f = form([q("a", { showIf: { question: "b", op: "answered" } }), q("b")]);
    expect(codes(f)).toEqual(["forward_reference"]);
  });

  test("logic that points at a deleted question is rejected", () => {
    const f = form([q("b", { showIf: { question: "gone", op: "equals", value: "x" } })]);
    expect(codes(f)).toEqual(["unknown_reference"]);
  });

  test("a deleted question in a section condition is rejected", () => {
    const f = form([], [{ id: "s1", title: "One", showIf: { question: "gone", op: "answered" }, questions: [q("a")] }]);
    expect(codes(f)).toEqual(["unknown_reference"]);
  });

  test("duplicate ids, empty choices, and a bad pattern are rejected", () => {
    const f = form([
      q("a"),
      q("a"),
      q("c", { type: "single_choice", choices: [] }),
      q("d", { rules: { pattern: "(" } }),
    ]);
    expect(codes(f)).toEqual(expect.arrayContaining(["duplicate_id", "no_choices", "bad_rule"]));
  });

  test("a valid form has no issues", () => {
    const f = form([q("a"), q("b", { showIf: { question: "a", op: "equals", value: "x" } })]);
    expect(validateForm(f)).toEqual([]);
  });

  test("a hidden answer does not feed later logic", () => {
    const f = form([
      q("a"),
      q("b", { showIf: { question: "a", op: "equals", value: "yes" } }),
      q("c", { showIf: { question: "b", op: "answered" } }),
    ]);
    const ids = visibleQuestions(f, { a: "no", b: "stale", c: "x" }).map((x) => x.id);
    expect(ids).toEqual(["a"]);
  });
});

describe("answer validation failures", () => {
  test("a hidden required question does not block the submit", () => {
    const f = form([
      q("a"),
      q("b", { required: true, showIf: { question: "a", op: "equals", value: "yes" } }),
    ]);
    expect(validateAnswers(f, { a: "no" }).ok).toBe(true);
    expect(validateAnswers(f, { a: "yes" }).issues[0]).toMatchObject({ code: "required", question: "b" });
  });

  test("an answer to a hidden question is dropped, not stored", () => {
    const f = form([q("a"), q("b", { showIf: { question: "a", op: "equals", value: "yes" } })]);
    expect(validateAnswers(f, { a: "no", b: "leak" }).answers).toEqual({ a: "no" });
  });

  test("an answer with a choice removed after answers exist is rejected", () => {
    const old = form([q("c", { type: "single_choice", choices: ["red", "blue"] })]);
    const edited = form([q("c", { type: "single_choice", choices: ["red"] })]);
    expect(validateAnswers(old, { c: "blue" }).ok).toBe(true);
    expect(validateAnswers(edited, { c: "blue" }).issues[0]).toMatchObject({ code: "invalid_choice" });
  });

  test("a multi choice with one removed choice or a repeat is rejected", () => {
    const f = form([q("m", { type: "multi_choice", choices: ["a", "b"] })]);
    expect(validateAnswers(f, { m: ["a", "z"] }).issues[0]?.code).toBe("invalid_choice");
    expect(validateAnswers(f, { m: ["a", "a"] }).issues[0]?.code).toBe("invalid_choice");
  });

  test("an unknown question id is rejected", () => {
    expect(validateAnswers(form([q("a")]), { nope: "x" }).issues[0]?.code).toBe("unknown_question");
  });

  test("a required question with an empty answer fails", () => {
    const f = form([q("a", { required: true }), q("m", { required: true, type: "multi_choice", choices: ["x"] })]);
    const result = validateAnswers(f, { a: "", m: [] });
    expect(result.issues.map((i) => i.code)).toEqual(["required", "required"]);
  });

  test("wrong types and out of range values fail", () => {
    const f = form([
      q("n", { type: "number", rules: { min: 1, max: 10 } }),
      q("e", { type: "email" }),
      q("d", { type: "date" }),
      q("r", { type: "rating" }),
      q("t", { rules: { maxLength: 3, pattern: "^[a-z]+$" } }),
    ]);
    const codesOf = (a: Record<string, string | number>) => validateAnswers(f, a).issues.map((i) => i.code);
    expect(codesOf({ n: "5" })).toEqual(["wrong_type"]);
    expect(codesOf({ n: 11 })).toEqual(["out_of_range"]);
    expect(codesOf({ n: Number.NaN })).toEqual(["wrong_type"]);
    expect(codesOf({ e: "not-an-email" })).toEqual(["wrong_type"]);
    expect(codesOf({ d: "2026-02-30" })).toEqual(["wrong_type"]);
    expect(codesOf({ r: 6 })).toEqual(["out_of_range"]);
    expect(codesOf({ r: 2.5 })).toEqual(["wrong_type"]);
    expect(codesOf({ t: "ABCD" })).toEqual(["too_long", "pattern"]);
  });

  test("a text answer over the hard cap fails even with no rule", () => {
    expect(validateAnswers(form([q("a")]), { a: "x".repeat(1001) }).issues[0]?.code).toBe("too_long");
  });

  test("a good set of answers passes and keeps its values", () => {
    const f = form([
      q("n", { type: "number" }),
      q("c", { type: "dropdown", choices: ["x", "y"] }),
      q("d", { type: "date" }),
      q("r", { type: "rating", rules: { max: 10 } }),
      q("f", { type: "file" }),
    ]);
    const answers = { n: 3, c: "y", d: "2026-10-28", r: 10, f: "blob/abc" };
    expect(validateAnswers(f, answers)).toMatchObject({ ok: true, answers });
  });
});
