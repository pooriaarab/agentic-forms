// A typed client for the Worker HTTP API. It uses only web APIs (fetch, URL, AbortSignal),
// so it runs in browsers, Workers, and Node 22. It never retries a call.
import type { Answers, Form } from "./core/form.js";
import type { formSpecSchema, questionSchema } from "./core/schema.js";
import type { z } from "zod";
import type { BackfillResult } from "./core/backfill.js";
import type { Response as FormResponse } from "./core/responses.js";
import type { AuditEntry } from "agentic-identity";

/** A spec as a caller writes it: defaults such as `required` may be left out. */
export type FormSpecInput = z.input<typeof formSpecSchema>;
export type QuestionInput = z.input<typeof questionSchema>;
export type ShareRole = "owner" | "editor" | "viewer";
export type SubjectKind = "human" | "agent";

export interface ClientOptions {
  /** The Worker origin, for example "https://forms.example.com". A path prefix is kept. */
  baseUrl: string;
  /** The bearer token for /api/v1. */
  token: string;
  /** Replaces the global fetch. Use it to add a proxy, a service binding, or a test double. */
  fetch?: typeof fetch;
}

/** Every method takes this last. Pass a signal to cancel the call. */
export interface CallOptions {
  signal?: AbortSignal;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** The API refused the call. `code` is the `error` field of the body, and `status` is the HTTP status. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** The decoded JSON body, or undefined when the body was not JSON. */
  readonly body: unknown;
  /** Set when the body lists faults: a bad spec (400), or answers that fail the form (422). */
  readonly issues?: unknown[];
  constructor(status: number, code: string, message: string, body?: unknown, issues?: unknown[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
    if (issues !== undefined) this.issues = issues;
  }
}

export function createClient(options: ClientOptions) {
  if (typeof options.baseUrl !== "string" || options.baseUrl === "") throw new TypeError("baseUrl is required");
  if (typeof options.token !== "string" || options.token === "") throw new TypeError("token is required");
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const id = encodeURIComponent;

  async function send(method: string, path: string, opts: { body?: unknown; query?: Record<string, string | number | undefined>; auth?: boolean } & CallOptions): Promise<Response> {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {};
    if (opts.auth !== false) headers.authorization = `Bearer ${options.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await doFetch(url.toString(), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: opts.signal });
    if (res.ok) return res;
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {}
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const code = typeof record.error === "string" ? record.error : `http_${res.status}`;
    const message = typeof record.message === "string" ? record.message : `${method} ${path} failed: ${res.status} ${code}`;
    throw new ApiError(res.status, code, message, body, Array.isArray(record.issues) ? record.issues : undefined);
  }
  const json = async <T>(method: string, path: string, opts: Parameters<typeof send>[2] = {}): Promise<T> => (await send(method, path, opts)).json() as Promise<T>;
  const form = (formId: string) => `/api/v1/forms/${id(formId)}`;

  return {
    /** GET /health. Needs no token. */
    health: (call: CallOptions = {}) => json<{ ok: true; version: string }>("GET", "/health", { ...call, auth: false }),
    /** GET /api/v1/forms. The forms the token's principal holds a role on. */
    listForms: async (call: CallOptions = {}) => (await json<{ forms: Form[] }>("GET", "/api/v1/forms", call)).forms,
    /** POST /api/v1/forms. Pass `publish` to open the form at once. */
    createForm: (spec: FormSpecInput & { publish?: boolean }, call: CallOptions = {}) => json<Form>("POST", "/api/v1/forms", { ...call, body: spec }),
    /** GET /api/v1/forms/:id. */
    getForm: (formId: string, call: CallOptions = {}) => json<Form>("GET", form(formId), call),
    /** POST /api/v1/forms/:id/questions. On a published form this starts a new draft version. */
    addQuestion: (formId: string, question: QuestionInput, sectionId?: string, call: CallOptions = {}) =>
      json<Form>("POST", `${form(formId)}/questions`, { ...call, body: { question, section: sectionId } }),
    /** POST /api/v1/forms/:id/publish. */
    publishForm: (formId: string, call: CallOptions = {}) => json<Form>("POST", `${form(formId)}/publish`, call),
    /** GET /api/v1/forms/:id/responses. One page, oldest first. Pass `nextCursor` back as `cursor`. */
    listResponses: (formId: string, query: { limit?: number; cursor?: string } = {}, call: CallOptions = {}) =>
      json<Page<FormResponse>>("GET", `${form(formId)}/responses`, { ...call, query }),
    /** GET /api/v1/forms/:id/export. All responses as CSV text. */
    exportCsv: async (formId: string, call: CallOptions = {}) => (await send("GET", `${form(formId)}/export`, call)).text(),
    /** POST /api/v1/forms/:id/purge. Deletes the responses past retention in this form. */
    purge: (formId: string, call: CallOptions = {}) => json<{ purged: number }>("POST", `${form(formId)}/purge`, call),
    /** DELETE /api/v1/forms/:id. Erases the form, its answers, and its grants. Owner only. */
    eraseForm: (formId: string, call: CallOptions = {}) => json<{ ok: true; erased: number }>("DELETE", form(formId), call),
    /** POST /api/v1/forms/:id/shares. A person and an agent with one id hold separate roles. */
    share: (formId: string, share: { subject: string; kind: SubjectKind; role: ShareRole }, call: CallOptions = {}) =>
      json<{ ok: true }>("POST", `${form(formId)}/shares`, { ...call, body: share }),
    /** DELETE /api/v1/forms/:id/shares/:subject?kind=. */
    revokeShare: (formId: string, subject: string, kind: SubjectKind, call: CallOptions = {}) =>
      json<{ ok: true }>("DELETE", `${form(formId)}/shares/${id(subject)}`, { ...call, query: { kind } }),
    /** GET /api/v1/forms/:id/audit. Owner only. */
    listAudit: (formId: string, query: { limit?: number; cursor?: string } = {}, call: CallOptions = {}) =>
      json<{ entries: AuditEntry[]; nextCursor?: string }>("GET", `${form(formId)}/audit`, { ...call, query }),
    /** POST /api/v1/purge. Every form at once. Needs the all-forms admin scope. */
    purgeAll: (call: CallOptions = {}) => json<{ purged: number; rateLimits: number }>("POST", "/api/v1/purge", call),
    /** POST /api/v1/migrate-grants. Needs the all-forms admin scope. */
    migrateGrants: (call: CallOptions = {}) => json<Record<string, unknown>>("POST", "/api/v1/migrate-grants", call),
    /** POST /api/v1/backfill-owners. One page per call: go on while `nextCursor` is set. Needs the all-forms admin scope. */
    backfillOwners: (owner: string, query: { limit?: number; cursor?: string } = {}, call: CallOptions = {}) =>
      json<BackfillResult>("POST", "/api/v1/backfill-owners", { ...call, body: { owner, ...query } }),
    /** POST /f/:id. The public submit. It sends no token. Pass `consent` only when the respondent agreed to the notice. */
    submit: (formId: string, answers: Answers, submitOptions: { consent?: boolean } & CallOptions = {}) =>
      json<{ ok: true }>("POST", `/f/${id(formId)}`, { signal: submitOptions.signal, auth: false, body: { answers, consent: submitOptions.consent } }),
  };
}

export type Client = ReturnType<typeof createClient>;
