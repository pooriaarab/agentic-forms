// The operations every face shares: SDK, CLI, MCP, and HTTP API call these.
import { formSpecSchema, formUpdateSchema, questionSchema, type FormSpec } from "./core/schema.js";
import { validateForm, type Answers, type Form, type Question, type Section } from "./core/form.js";
import { FormError, createFormRepo } from "./core/repo.js";
import { purgeRateLimits } from "./core/rate-limit.js";
import { backfillOwners } from "./core/backfill.js";
import { createResponses, purgeExpiredResponses } from "./core/responses.js";
import type { Store } from "agentic-identity";

export class OpsError extends Error {
  constructor(readonly kind: "not_found" | "conflict", message: string) {
    super(message);
    this.name = "OpsError";
  }
}

export type MadeBy = "human" | "agent";

const canon = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

/**
 * Sets `madeBy` on every question. A new or changed question takes `by`. An
 * unchanged one keeps its old mark. A mark that came in with the input is never trusted.
 */
export function markQuestions<S extends { questions: Question[] }>(before: Form | null, sections: S[], by?: MadeBy): S[] {
  const old = new Map<string, Question>();
  for (const section of before?.sections ?? []) for (const q of section.questions) old.set(q.id, q);
  const rest = ({ madeBy: _drop, ...q }: Question): Omit<Question, "madeBy"> => (q.rules !== undefined && Object.keys(q.rules).length === 0 ? { ...q, rules: undefined } : q);
  return sections.map((section) => ({
    ...section,
    questions: section.questions.map((q) => {
      const prior = old.get(q.id);
      const kept = prior !== undefined && canon(rest({ ...prior, required: prior.required ?? false })) === canon(rest({ ...q, required: q.required ?? false })) ? prior.madeBy : by;
      return { ...rest(q), ...(kept === undefined ? {} : { madeBy: kept }) } as Question;
    }),
  }));
}

export function createOps(store: Store) {
  const repo = createFormRepo(store);
  const responses = createResponses(store, repo);
  const get = async (id: string): Promise<Form> => {
    const form = await repo.get(id);
    if (!form) throw new OpsError("not_found", `form "${id}" not found`);
    return form;
  };
  /** Checks a JSON spec without storing it. Throws ZodError or FormError. */
  const check = (spec: unknown): FormSpec => {
    const parsed = formSpecSchema.parse(spec);
    const issues = validateForm({ ...parsed, version: 1, status: "draft" });
    if (issues.length > 0) throw new FormError(issues);
    return parsed;
  };
  return {
    repo,
    responses,
    get,
    check,
    /** Makes a form from a JSON spec. Throws ZodError, FormError, or OpsError. */
    async create(spec: unknown, publish = false, by?: MadeBy): Promise<Form> {
      const parsed = check(spec);
      if (await repo.get(parsed.id)) throw new OpsError("conflict", `form "${parsed.id}" already exists`);
      const draft = await repo.save({ ...parsed, sections: markQuestions(null, parsed.sections as Section[], by), version: 1, status: "draft" });
      return publish ? repo.publish(draft.id) : draft;
    },
    async addQuestion(formId: string, question: unknown, sectionId?: string, by?: MadeBy): Promise<Form> {
      const form = await get(formId);
      const section = sectionId === undefined ? form.sections[0] : form.sections.find((s) => s.id === sectionId);
      if (!section) throw new OpsError("not_found", `section "${sectionId}" not found`);
      const sections = form.sections.map((s) => (s === section ? { ...s, questions: [...s.questions, questionSchema.parse(question) as Question] } : s));
      // The save is a compare-and-set against the form just read, so the marks match what is stored.
      return repo.save({ ...form, sections: markQuestions(form, sections, by) }, { expectedRevision: form.revision ?? 0 });
    },
    /**
     * Replaces the title, notice, retention, and sections: this edits, reorders, and removes questions.
     * Editing a published form starts a new draft version. `notice` and `retentionDays` stay as stored unless you send them (null removes one).
     * With `expectedVersion` (a publish moved it) or `expectedRevision` (any save moved it), a head that moved is a VersionConflictError.
     */
    async update(formId: string, spec: unknown, by?: MadeBy): Promise<Form> {
      const { expectedVersion, expectedRevision, notice, retentionDays, ...parsed } = formUpdateSchema.parse(spec);
      const form = await get(formId);
      const next = { ...form, ...parsed, sections: markQuestions(form, parsed.sections as Section[], by) } as Form;
      // Absent keeps the stored value. null removes it, so a privacy setting never goes by omission.
      if (notice !== undefined) notice === null ? delete next.notice : (next.notice = notice);
      if (retentionDays !== undefined) retentionDays === null ? delete next.retentionDays : (next.retentionDays = retentionDays);
      // Without an expectedRevision the save still checks the form it read, so a notice kept by omission is the one stored.
      return repo.save(next, { expectedVersion, expectedRevision: expectedRevision ?? form.revision ?? 0 });
    },
    /** With `expectedRevision`, a draft that changed since you read it is a VersionConflictError and is not published. */
    async publish(formId: string, options: { expectedRevision?: number } = {}): Promise<Form> {
      await get(formId);
      return repo.publish(formId, options);
    },
    async submit(formId: string, answers: Answers, consent = false) {
      await get(formId);
      return responses.submit(formId, answers, { consent });
    },
    async listResponses(formId: string, options: { limit?: number; cursor?: string } = {}) {
      await get(formId);
      const page = await responses.list(formId, options);
      return { items: page.items.map((entry) => entry.data), nextCursor: page.nextCursor };
    },
    async exportCsv(formId: string) {
      await get(formId);
      return responses.exportCsv(formId);
    },
    /**
     * Hard-deletes responses past retention in every form, and finished rate-limit
     * counters. The scheduled job runs this. Each part runs even when the other
     * fails, and the failure is then thrown.
     */
    async purgeAll(now: number = Date.now()) {
      const [purged, rateLimits] = await Promise.allSettled([purgeExpiredResponses(store, now), purgeRateLimits(store, now)]);
      if (purged.status === "rejected" || rateLimits.status === "rejected") {
        throw new AggregateError([purged, rateLimits].flatMap((r) => (r.status === "rejected" ? [r.reason] : [])), "the purge failed");
      }
      return { purged: purged.value, rateLimits: rateLimits.value };
    },
    /** Gives forms made before roles an owner row for `owner`. One page per call: go on while `nextCursor` is set. Safe to run again. */
    backfillOwners: (owner: string, options?: { limit?: number; cursor?: string }) => backfillOwners(store, owner, options),
    /** Hard-deletes a form, its snapshots, and all its responses. Safe to run again. */
    async erase(formId: string) {
      // The head goes first, so a submit that comes later finds no form.
      await repo.erase(formId);
      return { erased: await responses.eraseAll(formId) };
    },
    async purge(formId: string) {
      await get(formId);
      return { purged: await responses.purgeExpired(formId) };
    },
  };
}

export type Ops = ReturnType<typeof createOps>;
