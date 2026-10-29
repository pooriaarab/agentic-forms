// The operations every face shares: SDK, CLI, MCP, and HTTP API call these.
import { formSpecSchema, questionSchema } from "./core/schema.js";
import type { Answers, Form } from "./core/form.js";
import { createFormRepo } from "./core/repo.js";
import { purgeRateLimits } from "./core/rate-limit.js";
import { createResponses, purgeExpiredResponses } from "./core/responses.js";
import type { Store } from "agentic-identity";

export class OpsError extends Error {
  constructor(readonly kind: "not_found" | "conflict", message: string) {
    super(message);
    this.name = "OpsError";
  }
}

export function createOps(store: Store) {
  const repo = createFormRepo(store);
  const responses = createResponses(store, repo);
  const get = async (id: string): Promise<Form> => {
    const form = await repo.get(id);
    if (!form) throw new OpsError("not_found", `form "${id}" not found`);
    return form;
  };
  return {
    repo,
    responses,
    get,
    /** Makes a form from a JSON spec. Throws ZodError, FormError, or OpsError. */
    async create(spec: unknown, publish = false): Promise<Form> {
      const parsed = formSpecSchema.parse(spec);
      if (await repo.get(parsed.id)) throw new OpsError("conflict", `form "${parsed.id}" already exists`);
      const draft = await repo.save({ ...parsed, version: 1, status: "draft" });
      return publish ? repo.publish(draft.id) : draft;
    },
    async addQuestion(formId: string, question: unknown, sectionId?: string): Promise<Form> {
      const form = await get(formId);
      const section = sectionId === undefined ? form.sections[0] : form.sections.find((s) => s.id === sectionId);
      if (!section) throw new OpsError("not_found", `section "${sectionId}" not found`);
      const sections = form.sections.map((s) => (s === section ? { ...s, questions: [...s.questions, questionSchema.parse(question)] } : s));
      return repo.save({ ...form, sections });
    },
    async publish(formId: string): Promise<Form> {
      await get(formId);
      return repo.publish(formId);
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
    async purge(formId: string) {
      await get(formId);
      return { purged: await responses.purgeExpired(formId) };
    },
  };
}

export type Ops = ReturnType<typeof createOps>;
