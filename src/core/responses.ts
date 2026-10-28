import { validateAnswers, type Answers, type Form, type Issue } from "./form.js";
import type { FormRepo } from "./repo.js";
import type { Doc, Page, Store } from "./store.js";

const COLLECTION = "responses";

/** One response as a table row: fixed columns plus one value per question id. */
export type Response = {
  id: string;
  formId: string;
  formVersion: number;
  submittedAt: string;
  values: Answers;
};

export class SubmitError extends Error {
  constructor(readonly issues: Issue[]) {
    super(`the answers have ${issues.length} fault${issues.length === 1 ? "" : "s"}: ${issues.map((i) => `${i.question}: ${i.message}`).join("; ")}`);
    this.name = "SubmitError";
  }
}

type Cell = string | number | boolean | undefined;

/** Writes RFC 4180 CSV. A text cell that starts with a formula character gets a leading quote mark. */
export function toCsv(rows: Cell[][]): string {
  const cell = (value: Cell): string => {
    if (value === undefined) return "";
    let text = String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => `${row.map(cell).join(",")}\n`).join("");
}

export function createResponses(store: Store, repo: FormRepo) {
  const list = async (formId: string, options: { limit?: number; cursor?: string } = {}) =>
    (await store.query(COLLECTION, {
      where: { formId },
      orderBy: { field: "submittedAt" },
      ...options,
    })) as unknown as Page & { items: { id: string; data: Response }[] };

  return {
    list,
    /** Checks the answers against the newest published version, then stores one row. */
    async submit(
      formId: string,
      answers: Answers,
      options: { now?: () => number; id?: string } = {},
    ): Promise<Response> {
      const form = await repo.getPublished(formId);
      if (!form) throw new Error(`form "${formId}" is not published`);
      const result = validateAnswers(form, answers);
      if (!result.ok) throw new SubmitError(result.issues);
      const response: Response = {
        id: options.id ?? crypto.randomUUID(),
        formId,
        formVersion: form.version,
        submittedAt: new Date((options.now ?? Date.now)()).toISOString(),
        values: result.answers,
      };
      await store.put(COLLECTION, response.id, response as unknown as Doc);
      return response;
    },
    /** Every response, across all versions. A question removed later stays a column. */
    async exportCsv(formId: string): Promise<string> {
      const rows: Response[] = [];
      let cursor: string | undefined;
      do {
        const page = await list(formId, { cursor });
        rows.push(...page.items.map((entry) => entry.data as unknown as Response));
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      const versions = [...new Set(rows.map((r) => r.formVersion))].sort((a, b) => b - a);
      const columns: string[] = [];
      for (const version of versions) {
        const form = (await repo.getVersion(formId, version)) as Form;
        for (const section of form.sections) {
          for (const question of section.questions) if (!columns.includes(question.id)) columns.push(question.id);
        }
      }
      return toCsv([
        ["response_id", "submitted_at", "form_version", ...columns],
        ...rows.map((r) => [
          r.id,
          r.submittedAt,
          r.formVersion,
          ...columns.map((id) => {
            const value = r.values[id];
            return Array.isArray(value) ? value.join("; ") : value;
          }),
        ]),
      ]);
    },
  };
}
