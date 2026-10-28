import { validateAnswers, type Answers, type Form, type Issue } from "./form.js";
import type { FormRepo } from "./repo.js";
import type { Doc, Store } from "./store.js";

const COLLECTION = "responses";

/** One response as a table row: fixed columns plus one value per question id. */
export type Response = {
  id: string;
  formId: string;
  formVersion: number;
  submittedAt: string;
  values: Answers;
  /** Set when the form has a notice and the respondent agreed. */
  consent?: boolean;
  /** Set when the form has a retention period. */
  retainUntil?: string;
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

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** True only for a valid ISO time at or after now. Any other value fails closed. */
const stillRetained = (retainUntil: unknown, now: number): boolean =>
  typeof retainUntil === "string" && ISO_TIME.test(retainUntil) && Date.parse(retainUntil) >= now;

export function createResponses(store: Store, repo: FormRepo) {
  type Page = { items: { id: string; data: Response }[]; nextCursor?: string };
  const rawList = async (formId: string, options: { limit?: number; cursor?: string } = {}) =>
    (await store.query(COLLECTION, {
      where: { formId },
      orderBy: { field: "submittedAt" },
      ...options,
    })) as unknown as Page;
  /** A row with no retain date stays. A row past its date, or with a bad date, is not shown. */
  const isLive = (data: Response, now: number) => data.retainUntil === undefined || stillRetained(data.retainUntil, now);
  const list = async (formId: string, options: { limit?: number; cursor?: string; now?: number } = {}): Promise<Page> => {
    const { now = Date.now(), ...query } = options;
    const page = await rawList(formId, query);
    return { ...page, items: page.items.filter((entry) => isLive(entry.data, now)) };
  };

  return {
    list,
    /** Checks the answers against the newest published version, then stores one row. */
    async submit(
      formId: string,
      answers: Answers,
      options: { now?: () => number; id?: string; consent?: boolean } = {},
    ): Promise<Response> {
      const form = await repo.getPublished(formId);
      if (!form) throw new Error(`form "${formId}" is not published`);
      const result = validateAnswers(form, answers);
      const issues = [...result.issues];
      if (form.notice !== undefined && options.consent !== true) {
        issues.push({ code: "consent_required", question: "consent", message: "agree to the notice first" });
      }
      if (issues.length > 0) throw new SubmitError(issues);
      const at = (options.now ?? Date.now)();
      const response: Response = {
        id: options.id ?? crypto.randomUUID(),
        formId,
        formVersion: form.version,
        submittedAt: new Date(at).toISOString(),
        values: result.answers,
        ...(form.notice !== undefined ? { consent: true } : {}),
        ...(form.retentionDays !== undefined ? { retainUntil: new Date(at + form.retentionDays * 86_400_000).toISOString() } : {}),
      };
      await store.put(COLLECTION, response.id, response as unknown as Doc);
      return response;
    },
    /** Deletes responses past their retention date. Returns the count. Rows with no date stay. A date that is not a valid time counts as expired. */
    async purgeExpired(formId: string, now: number = Date.now()): Promise<number> {
      let purged = 0;
      let cursor: string | undefined;
      do {
        const page = await rawList(formId, { cursor });
        for (const { id, data } of page.items) {
          if (!isLive(data, now)) {
            await store.delete(COLLECTION, id);
            purged++;
          }
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return purged;
    },
    /** Every response still within retention, across all versions. A question removed later stays a column. */
    async exportCsv(formId: string, now: number = Date.now()): Promise<string> {
      const rows: Response[] = [];
      let cursor: string | undefined;
      do {
        const page = await list(formId, { cursor, now });
        rows.push(...page.items.map((entry) => entry.data as unknown as Response));
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      const versions = [...new Set(rows.map((r) => r.formVersion))].sort((a, b) => b - a);
      const columns: string[] = [];
      for (const version of versions) {
        const form = await repo.getVersion(formId, version);
        if (!form) throw new Error(`snapshot "${formId}@${version}" is missing`);
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
