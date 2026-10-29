// A typed client for the Worker HTTP API. It uses only web APIs (fetch, URL, AbortSignal),
// so it runs in browsers, Workers, and Node 22. It never retries a call.
import type { Answers, Form } from "./core/form.js";
import type { formSpecSchema, formUpdateSchema, questionSchema } from "./core/schema.js";
import type { z } from "zod";
import type { BackfillResult } from "./core/backfill.js";
import type { Response as FormResponse } from "./core/responses.js";
import type { AuditEntry } from "agentic-identity";

/** A spec as a caller writes it: defaults such as `required` may be left out. */
export type FormSpecInput = z.input<typeof formSpecSchema>;
export type FormUpdateInput = z.input<typeof formUpdateSchema>;
export type QuestionInput = z.input<typeof questionSchema>;
export type ShareRole = "owner" | "editor" | "viewer";
export type SubjectKind = "human" | "agent";
/** An invite or a link gives editor or viewer. Only a grant makes an owner. */
export type InviteRole = "editor" | "viewer";
export interface InviteInput {
  role: InviteRole;
  /** The person to invite. Give this or `handle`. */
  email?: string;
  /** The agent to invite. Give this or `email`. */
  handle?: string;
  /** How long the invite lives, in milliseconds. */
  expiresInMs?: number;
}
export interface LinkInput {
  role: InviteRole;
  signedInOnly?: boolean;
  expiresInMs?: number;
}
/** An invite as a list shows it: no email. */
export interface FormInvite {
  id: string;
  resourceId: string;
  role: InviteRole;
  for: "email" | "handle";
  handle?: string;
  expiresAt?: number;
  acceptedAt?: number;
  revokedAt?: number;
}
/** A link as a list shows it: no token. */
export interface FormLink {
  id: string;
  role: InviteRole;
  signedInOnly: boolean;
  expiresAt?: number;
  revokedAt?: number;
}

export interface ClientOptions {
  /** The Worker origin as an absolute URL, for example "https://forms.example.com". A path prefix is kept. */
  baseUrl: string;
  /** The bearer token for /api/v1. Leave it out to call only `health` and `submit`, which send no token. A function is called before each request, so a host app can refresh the token. */
  token?: string | (() => string | Promise<string>);
  /** Replaces the global fetch. Use it to add a proxy or a test double. For a service binding, wrap it: `(input, init) => env.FORMS.fetch(input, init)`. */
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
  /** Seconds to wait, from the `retry-after` header of a 429. */
  readonly retryAfter?: number;
  constructor(status: number, code: string, message: string, body?: unknown, issues?: unknown[], retryAfter?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
    if (issues !== undefined) this.issues = issues;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export function createClient(options: ClientOptions) {
  if (typeof options.baseUrl !== "string" || options.baseUrl === "") throw new TypeError("baseUrl is required");
  if (options.token !== undefined && typeof options.token !== "function" && (typeof options.token !== "string" || options.token === "")) throw new TypeError("token must be a non-empty string or a function");
  let parsed: URL;
  try {
    parsed = new URL(options.baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }
  if (parsed.username !== "" || parsed.password !== "") throw new TypeError("baseUrl must have no user info: pass the token instead");
  if (parsed.search !== "" || parsed.hash !== "") throw new TypeError("baseUrl must have no query or fragment");
  // An empty "?" or "#" at the end passes the check above, so the base is built from the parsed parts.
  if (/[?#]/.test(options.baseUrl)) throw new TypeError("baseUrl must have no query or fragment");
  const base = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  // encodeURIComponent keeps dots, and a "." or ".." segment makes the URL parser change the route.
  const id = (value: string) => {
    if (typeof value !== "string" || value === "" || /^\.{1,2}$/.test(value)) throw new TypeError(`"${String(value)}" is not a valid id`);
    return encodeURIComponent(value);
  };

  async function send(method: string, path: string, opts: { body?: unknown; query?: Record<string, string | number | undefined>; auth?: boolean } & CallOptions): Promise<Response> {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {};
    if (opts.auth !== false) {
      if (options.token === undefined) throw new TypeError("this call needs a token: pass one to createClient");
      const token = typeof options.token === "function" ? await options.token() : options.token;
      if (typeof token !== "string" || token === "") throw new TypeError("the token function must return a non-empty string");
      headers.authorization = `Bearer ${token}`;
    }
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
    // A body that is not JSON (the public page answers text) still explains the fault.
    const plain = body === undefined && text !== "" && text.length <= 200 && !text.trimStart().startsWith("<") ? text : undefined;
    const message = typeof record.message === "string" ? record.message : (plain ?? `${method} ${path} failed: ${res.status} ${code}`);
    const header = res.headers.get("retry-after")?.trim();
    const wait = header === undefined || header === "" ? Number.NaN : Number(header);
    throw new ApiError(res.status, code, message, body, Array.isArray(record.issues) ? record.issues : undefined, Number.isFinite(wait) ? wait : undefined);
  }
  const json = async <T>(method: string, path: string, opts: Parameters<typeof send>[2] = {}): Promise<T> => {
    const res = await send(method, path, opts);
    try {
      return (await res.json()) as T;
    } catch (error) {
      // Only a parse fault is the reply's fault. A cancel or a dropped connection keeps its own error.
      if (!(error instanceof SyntaxError)) throw error;
      // A proxy or a wrong baseUrl can answer 200 with a page that is not JSON.
      throw new ApiError(res.status, "bad_response", `${method} ${path} answered ${res.status} with a body that is not JSON`);
    }
  };
  const form = (formId: string) => `/api/v1/forms/${id(formId)}`;

  const methods = {
    /** GET /health. Needs no token. */
    health: (call: CallOptions = {}) => json<{ ok: true; version: string }>("GET", "/health", { signal: call.signal, auth: false }),
    /** GET /api/v1/forms. The forms the token's principal holds a role on. */
    listForms: async (call: CallOptions = {}) => (await json<{ forms: Form[] }>("GET", "/api/v1/forms", { signal: call.signal })).forms,
    /** POST /api/v1/forms. Pass `publish` to open the form at once. */
    createForm: (spec: FormSpecInput & { publish?: boolean }, call: CallOptions = {}) => json<Form>("POST", "/api/v1/forms", { signal: call.signal, body: spec }),
    /** GET /api/v1/forms/:id. */
    getForm: (formId: string, call: CallOptions = {}) => json<Form>("GET", form(formId), { signal: call.signal }),
    /** PUT /api/v1/forms/:id. Replaces title, notice, retention, and sections: edit, reorder, or remove questions. Pass `expectedRevision` (from `form.revision ?? 0`) to refuse the write when anyone saved since you read it, or `expectedVersion` to refuse it after a publish (409 `version_conflict`). An absent notice or retentionDays is kept: send null to remove one. */
    updateForm: (formId: string, spec: FormUpdateInput, call: CallOptions = {}) => json<Form>("PUT", form(formId), { signal: call.signal, body: spec }),
    /** POST /api/v1/forms/:id/questions. On a published form this starts a new draft version. */
    addQuestion: (formId: string, question: QuestionInput, addOptions: { section?: string } & CallOptions = {}) =>
      json<Form>("POST", `${form(formId)}/questions`, { signal: addOptions.signal, body: { question, section: addOptions.section } }),
    /** POST /api/v1/forms/:id/publish. Pass `expectedRevision` (from `form.revision ?? 0`) to refuse a draft that changed since you read it (409 `version_conflict`). */
    publishForm: (formId: string, publishOptions: { expectedRevision?: number } & CallOptions = {}) =>
      json<Form>("POST", `${form(formId)}/publish`, { signal: publishOptions.signal, body: publishOptions.expectedRevision === undefined ? undefined : { expectedRevision: publishOptions.expectedRevision } }),
    /** GET /api/v1/forms/:id/responses. One page, oldest first. Pass `nextCursor` back as `cursor`. */
    listResponses: (formId: string, query: { limit?: number; cursor?: string } = {}, call: CallOptions = {}) =>
      json<Page<FormResponse>>("GET", `${form(formId)}/responses`, { signal: call.signal, query }),
    /** GET /api/v1/forms/:id/export. All responses as CSV text. */
    exportCsv: async (formId: string, call: CallOptions = {}) => {
      const res = await send("GET", `${form(formId)}/export`, { signal: call.signal });
      if (!(res.headers.get("content-type") ?? "").startsWith("text/csv")) throw new ApiError(res.status, "bad_response", `GET /export answered ${res.status} with a body that is not CSV`);
      return res.text();
    },
    /** POST /api/v1/forms/:id/purge. Deletes the responses past retention in this form. */
    purge: (formId: string, call: CallOptions = {}) => json<{ purged: number }>("POST", `${form(formId)}/purge`, { signal: call.signal }),
    /** DELETE /api/v1/forms/:id. Erases the form, its answers, and its grants. Owner only. */
    eraseForm: (formId: string, call: CallOptions = {}) => json<{ ok: true; erased: number }>("DELETE", form(formId), { signal: call.signal }),
    /** POST /api/v1/forms/:id/shares. A person and an agent with one id hold separate roles. */
    share: (formId: string, share: { subject: string; kind: SubjectKind; role: ShareRole }, call: CallOptions = {}) =>
      json<{ ok: true }>("POST", `${form(formId)}/shares`, { signal: call.signal, body: share }),
    /** GET /api/v1/forms/:id/shares. Who holds a role. Owner only. One page: pass `nextCursor` back as `cursor`. */
    listShares: (formId: string, query: { limit?: number; cursor?: string } = {}, call: CallOptions = {}) =>
      json<{ grants: { resourceId: string; subjectKind: SubjectKind; subjectId: string; role: string }[]; nextCursor?: string }>("GET", `${form(formId)}/shares`, { signal: call.signal, query }),
    /** DELETE /api/v1/forms/:id/shares/:subject?kind=. */
    revokeShare: (formId: string, subject: string, kind: SubjectKind, call: CallOptions = {}) =>
      json<{ ok: true }>("DELETE", `${form(formId)}/shares/${id(subject)}`, { signal: call.signal, query: { kind } }),
    /** POST /api/v1/forms/:id/invites. Invite a person by `email` or an agent by `handle`, not both. The role is editor or viewer. Owner only. */
    invite: (formId: string, invite: InviteInput, call: CallOptions = {}) =>
      json<{ id: string }>("POST", `${form(formId)}/invites`, { signal: call.signal, body: invite }),
    /** GET /api/v1/forms/:id/invites. One page. An invite shows no email. Owner only. */
    listInvites: (formId: string, query: { limit?: number; cursor?: string } = {}, call: CallOptions = {}) =>
      json<{ invites: FormInvite[]; nextCursor?: string }>("GET", `${form(formId)}/invites`, { signal: call.signal, query }),
    /** POST /api/v1/forms/:id/links. The token shows once, in this reply. Owner only. */
    createLink: (formId: string, link: LinkInput, call: CallOptions = {}) =>
      json<{ id: string; token: string }>("POST", `${form(formId)}/links`, { signal: call.signal, body: link }),
    /** GET /api/v1/forms/:id/links. One page. A link shows no token. Owner only. */
    listLinks: (formId: string, query: { limit?: number; cursor?: string } = {}, call: CallOptions = {}) =>
      json<{ links: FormLink[]; nextCursor?: string }>("GET", `${form(formId)}/links`, { signal: call.signal, query }),
    /** DELETE /api/v1/forms/:id/links/:link. Owner only. */
    revokeLink: (formId: string, linkId: string, call: CallOptions = {}) =>
      json<{ ok: true }>("DELETE", `${form(formId)}/links/${id(linkId)}`, { signal: call.signal }),
    /** GET /api/v1/forms/:id/audit. Owner only. */
    listAudit: (formId: string, query: { limit?: number; cursor?: string } = {}, call: CallOptions = {}) =>
      json<{ entries: AuditEntry[]; nextCursor?: string }>("GET", `${form(formId)}/audit`, { signal: call.signal, query }),
    /** POST /api/v1/purge. Every form at once. Needs the all-forms admin scope. */
    purgeAll: (call: CallOptions = {}) => json<{ purged: number; rateLimits: number }>("POST", "/api/v1/purge", { signal: call.signal }),
    /** POST /api/v1/migrate-grants. Needs the all-forms admin scope. */
    migrateGrants: (call: CallOptions = {}) => json<{ migrated: number; unresolved: string[] }>("POST", "/api/v1/migrate-grants", { signal: call.signal }),
    /** POST /api/v1/backfill-owners. One page per call: go on while `nextCursor` is set. Needs the all-forms admin scope. */
    backfillOwners: (owner: string, query: { limit?: number; cursor?: string } = {}, call: CallOptions = {}) =>
      json<BackfillResult>("POST", "/api/v1/backfill-owners", { signal: call.signal, body: { owner, ...query } }),
    /** POST /f/:id. The public submit. It sends no token. Pass `consent` only when the respondent agreed to the notice. */
    submit: (formId: string, answers: Answers, submitOptions: { consent?: boolean } & CallOptions = {}) =>
      json<{ ok: true }>("POST", `/f/${id(formId)}`, { signal: submitOptions.signal, auth: false, body: { answers, consent: submitOptions.consent } }),
  };
  // A refused id throws before a request is built. The wrapper turns that throw into a rejection, so every fault reaches the caller the same way.
  return Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, async (...args: unknown[]) => (method as (...a: unknown[]) => unknown)(...args)])) as typeof methods;
}

export type Client = ReturnType<typeof createClient>;
