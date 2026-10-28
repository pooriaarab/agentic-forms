// The form model, its logic checks, and answer validation. Pure code: no I/O.
import { RE2JS } from "re2js";

export type QuestionType =
  | "short_text"
  | "long_text"
  | "number"
  | "email"
  | "single_choice"
  | "multi_choice"
  | "dropdown"
  | "date"
  | "rating"
  | "file";

export type Rules = {
  minLength?: number;
  maxLength?: number;
  /** A regular expression, up to 256 characters, in the linear-time RE2 syntax (no backreferences or lookaround). Applies to text answers. */
  pattern?: string;
  /** Number range, rating start, or the count range of a multi choice. */
  min?: number;
  max?: number;
};

export type Condition = {
  /** An earlier question. A hidden question counts as unanswered. */
  question: string;
  op: "equals" | "not_equals" | "contains" | "gt" | "lt" | "answered";
  value?: string | number;
};

export type Question = {
  id: string;
  type: QuestionType;
  label: string;
  required: boolean;
  choices?: string[];
  rules?: Rules;
  showIf?: Condition;
};

export type Section = {
  id: string;
  title: string;
  showIf?: Condition;
  questions: Question[];
};

export type Form = {
  id: string;
  title: string;
  version: number;
  status: "draft" | "published";
  /** Privacy notice. When set, a respondent must consent before an answer is stored. */
  notice?: string;
  /** Days to keep each response. Unset keeps responses until you delete them. */
  retentionDays?: number;
  sections: Section[];
};

/** A file answer is a blob key. */
export type AnswerValue = string | number | string[];
export type Answers = Record<string, AnswerValue>;

export type Issue = { code: string; message: string; question?: string };

const CHOICE_TYPES: QuestionType[] = ["single_choice", "multi_choice", "dropdown"];
const TEXT_CAP: Partial<Record<QuestionType, number>> = { short_text: 1000, long_text: 20000 };
const PATTERN_CAP = 256;
/** A text answer longer than this is refused before any pattern runs. */
const PATTERN_INPUT_CAP = 1000;
const RATING_SPAN_CAP = 20;
/** Fixed columns of a response row. A question cannot reuse them. */
const RESERVED_IDS = ["response_id", "submitted_at", "form_version"];

const own = (answers: Answers, id: string): AnswerValue | undefined =>
  Object.prototype.hasOwnProperty.call(answers, id) ? answers[id] : undefined;

const compilePattern = (pattern: string): RE2JS => RE2JS.compile(pattern);

const isEmpty = (value: AnswerValue | undefined): boolean =>
  value === undefined || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);

function matches(condition: Condition, answers: Answers): boolean {
  const answer = own(answers, condition.question);
  const { value } = condition;
  const equals = Array.isArray(answer) ? answer.includes(value as string) : answer === value;
  switch (condition.op) {
    case "answered":
      return !isEmpty(answer);
    case "equals":
      return equals;
    case "not_equals":
      return !equals;
    case "contains":
      return (
        (typeof answer === "string" && typeof value === "string" && answer.includes(value)) ||
        (Array.isArray(answer) && answer.includes(value as string))
      );
    case "gt":
      return typeof answer === "number" && typeof value === "number" && answer > value;
    case "lt":
      return typeof answer === "number" && typeof value === "number" && answer < value;
  }
}

/** The questions a respondent sees, in order. Hidden answers never feed later logic. */
export function visibleQuestions(form: Form, answers: Answers): Question[] {
  const seen: Answers = Object.create(null);
  const shown: Question[] = [];
  for (const section of form.sections) {
    if (section.showIf && !matches(section.showIf, seen)) continue;
    for (const question of section.questions) {
      if (question.showIf && !matches(question.showIf, seen)) continue;
      const answer = own(answers, question.id);
      if (answer !== undefined) seen[question.id] = answer;
      shown.push(question);
    }
  }
  return shown;
}

/** Checks a form for structure and logic faults. An empty list means the form is sound. */
export function validateForm(form: Form): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, message: string, question?: string) =>
    issues.push({ code, message, ...(question ? { question } : {}) });

  if (form.retentionDays !== undefined && !(Number.isInteger(form.retentionDays) && form.retentionDays >= 1 && form.retentionDays <= 3650)) {
    add("bad_setting", "retention must be a whole number of days from 1 to 3650");
  }
  if (form.notice !== undefined && (form.notice.trim() === "" || form.notice.length > 5000)) {
    add("bad_setting", "the notice must hold 1 to 5000 characters");
  }

  const index = new Map<string, number>();
  const sectionIds = new Set<string>();
  let count = 0;
  for (const section of form.sections) {
    if (sectionIds.has(section.id)) add("duplicate_id", `section "${section.id}" repeats`);
    sectionIds.add(section.id);
    for (const q of section.questions) {
      if (RESERVED_IDS.includes(q.id)) add("reserved_id", `"${q.id}" is a fixed column name`, q.id);
      if (index.has(q.id)) add("duplicate_id", `question "${q.id}" repeats`, q.id);
      else index.set(q.id, count);
      count++;
      checkQuestion(q, add);
    }
  }

  // Dependency graph: a node needs the question its condition reads, and a
  // question needs its section.
  const edges = new Map<string, { to: string; owner: number; ref: string; label?: string }[]>();
  const link = (from: string, cond: Condition | undefined, owner: number, label?: string) => {
    const list = edges.get(from) ?? [];
    edges.set(from, list);
    if (!cond) return;
    if (cond.op !== "answered" && cond.value === undefined) {
      add("bad_condition", `logic "${cond.op}" needs a value`, label);
    } else if ((cond.op === "gt" || cond.op === "lt") && typeof cond.value !== "number") {
      add("bad_condition", `logic "${cond.op}" needs a number`, label);
    }
    if (!index.has(cond.question)) {
      add("unknown_reference", `logic reads missing question "${cond.question}"`, label);
      return;
    }
    list.push({ to: `q:${cond.question}`, owner, ref: cond.question, label });
  };
  let position = 0;
  for (const section of form.sections) {
    link(`s:${section.id}`, section.showIf, position);
    for (const q of section.questions) {
      link(`q:${q.id}`, q.showIf, position, q.id);
      edges.get(`q:${q.id}`)!.push({ to: `s:${section.id}`, owner: -1, ref: "" });
      position++;
    }
  }

  let cyclic = false;
  const state = new Map<string, 1 | 2>();
  const walk = (node: string): void => {
    state.set(node, 1);
    for (const edge of edges.get(node) ?? []) {
      if (state.get(edge.to) === 1) {
        cyclic = true;
        add("logic_cycle", `logic loops through "${edge.to.slice(2)}"`, edge.to.startsWith("q:") ? edge.to.slice(2) : undefined);
      } else if (!state.has(edge.to)) walk(edge.to);
    }
    state.set(node, 2);
  };
  for (const node of edges.keys()) if (!state.has(node)) walk(node);

  if (!cyclic) {
    for (const list of edges.values()) {
      for (const edge of list) {
        if (edge.owner >= 0 && index.get(edge.ref)! >= edge.owner) {
          add("forward_reference", `logic reads "${edge.ref}", which comes later`, edge.label);
        }
      }
    }
  }
  return issues;
}

/** Faults that block publishing but not saving a draft. A required file question has no upload on the fill page. */
export function validateForPublish(form: Form): Issue[] {
  const issues = validateForm(form);
  for (const section of form.sections) {
    for (const q of section.questions) {
      if (q.type === "file" && q.required) {
        issues.push({ code: "file_not_supported", question: q.id, message: "a required file question cannot be filled on the public page yet" });
      }
    }
  }
  return issues;
}

function checkQuestion(q: Question, add: (code: string, message: string, question?: string) => void): void {
  if (CHOICE_TYPES.includes(q.type)) {
    const choices = q.choices ?? [];
    if (choices.length === 0 || new Set(choices).size !== choices.length) {
      add("no_choices", "a choice question needs one or more unique choices", q.id);
    }
  }
  const r = q.rules;
  if (!r) return;
  const bad = (why: string) => add("bad_rule", why, q.id);
  for (const key of ["minLength", "maxLength"] as const) {
    if (r[key] !== undefined && !(Number.isInteger(r[key]) && r[key]! >= 0)) bad(`${key} must be an integer of 0 or more`);
  }
  for (const key of ["min", "max"] as const) {
    if (r[key] !== undefined && !Number.isFinite(r[key])) bad(`${key} must be a number`);
  }
  if (r.min !== undefined && r.max !== undefined && r.min > r.max) bad("min is above max");
  if (q.type === "rating") {
    const min = r.min ?? 1;
    const max = r.max ?? 5;
    if (!Number.isInteger(min) || !Number.isInteger(max) || max - min + 1 > RATING_SPAN_CAP) {
      bad(`a rating needs whole numbers that span ${RATING_SPAN_CAP} steps or fewer`);
    }
  }
  if (r.pattern !== undefined) {
    try {
      if (typeof r.pattern !== "string" || r.pattern.length > PATTERN_CAP) throw new Error("long");
      compilePattern(r.pattern);
    } catch {
      bad(`pattern must be a valid RE2 expression (no backreferences or lookaround) of ${PATTERN_CAP} characters or fewer`);
    }
  }
}

export type AnswerResult = { ok: boolean; issues: Issue[]; answers: Answers };

/** Validates answers against a form. The result keeps only answers to visible questions. */
export function validateAnswers(form: Form, input: Answers): AnswerResult {
  // No prototype, so a question id like "constructor" reads as unanswered.
  const answers: Answers = Object.assign(Object.create(null), input);
  const issues: Issue[] = [];
  const add = (code: string, question: string, message: string) => issues.push({ code, question, message });
  const known = new Set(form.sections.flatMap((s) => s.questions.map((q) => q.id)));
  for (const id of Object.keys(answers)) {
    if (!known.has(id)) issues.push({ code: "unknown_question", question: id, message: `no question "${id}"` });
  }
  const cleaned: Answers = Object.create(null);
  for (const q of visibleQuestions(form, answers)) {
    const value = own(answers, q.id);
    if (isEmpty(value)) {
      if (q.required) add("required", q.id, "this question needs an answer");
      continue;
    }
    cleaned[q.id] = value!;
    checkAnswer(q, value!, (code, message) => add(code, q.id, message));
  }
  return { ok: issues.length === 0, issues, answers: cleaned };
}

function checkAnswer(q: Question, value: AnswerValue, add: (code: string, message: string) => void): void {
  const r = q.rules ?? {};
  const wrong = () => add("wrong_type", `expected ${q.type}`);
  const range = (n: number, min: number | undefined, max: number | undefined) => {
    if ((min !== undefined && n < min) || (max !== undefined && n > max)) add("out_of_range", "outside the allowed range");
  };
  switch (q.type) {
    case "short_text":
    case "long_text": {
      if (typeof value !== "string") return wrong();
      if (value.length > (r.maxLength ?? TEXT_CAP[q.type]!) || value.length > TEXT_CAP[q.type]!) add("too_long", "the answer is too long");
      if (r.minLength !== undefined && value.length < r.minLength) add("too_short", "the answer is too short");
      if (r.pattern !== undefined) {
        if (value.length > PATTERN_INPUT_CAP) {
          if (value.length <= TEXT_CAP[q.type]!) add("too_long", "the answer is too long for its format rule");
        } else if (!compilePattern(r.pattern).matcher(value).find()) add("pattern", "the answer has the wrong format");
      }
      return;
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return wrong();
      return range(value, r.min, r.max);
    case "email":
      if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return wrong();
      return;
    case "single_choice":
    case "dropdown":
      if (typeof value !== "string") return wrong();
      if (!q.choices?.includes(value)) add("invalid_choice", "this choice is not on the form");
      return;
    case "multi_choice":
      if (!Array.isArray(value)) return wrong();
      if (new Set(value).size !== value.length || value.some((v) => !q.choices?.includes(v))) {
        add("invalid_choice", "a choice is not on the form, or repeats");
      }
      return range(value.length, r.min, r.max);
    case "date":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return wrong();
      {
        const day = new Date(`${value}T00:00:00Z`);
        if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) wrong();
      }
      return;
    case "rating":
      if (typeof value !== "number" || !Number.isInteger(value)) return wrong();
      return range(value, r.min ?? 1, r.max ?? 5);
    case "file":
      if (typeof value !== "string" || value === "" || value.length > 256) wrong();
      return;
  }
}
