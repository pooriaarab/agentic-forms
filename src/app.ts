import { Hono, type Context, type Next } from "hono";
import { ZodError, z } from "zod";
import { SubmitError } from "./core/responses.js";
import { FormError, VersionConflictError } from "./core/repo.js";
import type { Form } from "./core/form.js";
import { EraseRefusedError, MAX_AUDIT_PAGE, MAX_OWNERS_ON_ERASE, ROLES, SUBJECT_KINDS, createMemoryStore, createSharing, hasScope, isMachineMade, migrateGrants, type Action, type Auth, type PrincipalContext, type Role, type Store, type SubjectKind } from "agentic-identity";
import { requirePrincipal } from "agentic-identity/http";
import { clientKey, createRateLimiter } from "./core/rate-limit.js";
import { BackfillError } from "./core/backfill.js";
import { FORM_ID, SUBJECT_ID, wellFormedCursor } from "./core/schema.js";
import { OpsError, createOps } from "./ops.js";
import { renderFillPage } from "./page.js";
import { VERSION } from "./version.js";

const MAX_BODY = 65_536;
const SUBJECT = SUBJECT_ID;
/** The handle rule of agentic-identity for an agent. The invite route checks it, so a bad handle is a 400, not a 500. */
/** The roles an invite or a link row may hold and still work. This API makes editor and viewer; the library also honors commenter. */
const LISTED_ROLES: ReadonlySet<string> = new Set(["viewer", "commenter", "editor"]);
const HANDLE = /^[a-z][a-z0-9_-]{1,31}$/;
const publishBody = z.object({ expectedRevision: z.number().int().min(0).optional() }).strict();
const by = (ctx: PrincipalContext) => (isMachineMade(ctx.kind) ? "agent" : "human");
const isSubjectKind = (kind: unknown): kind is SubjectKind => SUBJECT_KINDS.includes(kind as SubjectKind);
const MAX_LIMIT = 1000;

const SHARE_ROLES: readonly Role[] = ["owner", "editor", "viewer"];

/** The caller may not do this. A caller with no role on the form gets 404, so a form id never leaks. */
class AccessError extends Error {
  constructor(readonly status: 403 | 404) {
    super("forbidden");
  }
}

export interface AppOptions {
  /** Set it when the static UI is served next to the app: `GET /` then goes to /ui/. */
  ui?: boolean;
  store?: Store;
  /** Names the caller of /api/v1 from the request. With no `auth` the API answers 503. There is no default. */
  auth?: Auth;
  /** Submits allowed per client in each window. Defaults to 20 a minute. Pass `false` to turn it off. The counters live in the store. */
  rateLimit?: { limit: number; windowMs: number } | false;
  /** Keys the hash of each client address in the stored counters. At least 32 bytes. createApp throws without it, unless `rateLimit` is false. There is no default. */
  rateLimitSecret?: string;
  /** Off by default. Return false to refuse a submit. Plug a check here that runs on your own host. */
  botCheck?: (request: Request, body: Record<string, unknown>) => boolean | Promise<boolean>;
  now?: () => number;
}

const PAGE_HEADERS = (nonce: string) => ({
  "content-security-policy": `default-src 'none'; style-src 'self' 'nonce-${nonce}'; font-src 'self'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
});

export function createApp(options: AppOptions = {}) {
  const store = options.store ?? createMemoryStore();
  const ops = createOps(store);
  const { repo, responses } = ops;
  const now = options.now ?? Date.now;
  const sharing = createSharing(store, { now });
  const limiter =
    options.rateLimit === false ? undefined : createRateLimiter(store, options.rateLimit ?? { limit: 20, windowMs: 60_000 }, options.rateLimitSecret as string, now);

  const app = new Hono<{ Variables: { ctx: PrincipalContext } }>();
  // Only a deployment that serves the UI assets sends people there.
  if (options.ui === true) app.get("/", (c) => c.redirect("/ui/"));
  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

  // A malformed id never reaches the store, which would throw on it.
  app.use("/f/:id", async (c, next) => (FORM_ID.test(c.req.param("id")) ? next() : c.text("This form id is not valid.", 400)));

  app.get("/f/:id", async (c) => {
    const form = await repo.getPublished(c.req.param("id"));
    if (!form) return c.text("This form is not available.", 404);
    const nonce = crypto.randomUUID();
    return c.html(renderFillPage(form, nonce), 200, PAGE_HEADERS(nonce));
  });

  app.post("/f/:id", async (c) => {
    const id = c.req.param("id");
    // A read is cheaper than a counter write, so an unknown form never makes a counter.
    if (!(await repo.getPublished(id))) return c.json({ error: "not_found" }, 404);
    const wait = (await limiter?.hit(clientKey(c.req.header("cf-connecting-ip") ?? "unknown"))) ?? 0;
    if (wait > 0) return c.json({ error: "rate_limited" }, 429, { "retry-after": String(wait) });
    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return c.json({ error: "too_large" }, 413);
    const text = await readCapped(c.req.raw, MAX_BODY);
    if (text === undefined) return c.json({ error: "too_large" }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "bad_json" }, 400);
    }
    const answers = body?.answers;
    if (typeof body !== "object" || body === null || typeof answers !== "object" || answers === null || Array.isArray(answers)) {
      return c.json({ error: "bad_body" }, 400);
    }
    if (options.botCheck && !(await options.botCheck(c.req.raw, body))) return c.json({ error: "bot_check_failed" }, 403);
    try {
      await responses.submit(id, answers as Record<string, never>, { consent: body.consent === true, now });
    } catch (error) {
      if (error instanceof SubmitError) return c.json({ error: "invalid", issues: error.issues }, 422);
      throw error;
    }
    return c.json({ ok: true }, 201, { "cache-control": "no-store" });
  });

  app.use("/api/v1/*", async (c, next) => {
    if (!options.auth) return c.json({ error: "api_disabled" }, 503);
    const ctx = await requirePrincipal(c.req.raw, options.auth);
    if (ctx instanceof Response) return ctx;
    if (ctx.chain.length === 0) return c.json({ error: "unauthorized" }, 401);
    c.set("ctx", ctx);
    await next();
  });
  /** Decides and audits. Throws AccessError unless the caller's role and scopes allow `action` on the form. */
  const require = async (c: { get(key: "ctx"): PrincipalContext }, action: Action, formId: string) => {
    const ctx = c.get("ctx");
    // The resource namespace is shared. A resource of another type with this id is not a form.
    const resource = await store.get("resources", formId);
    if (resource !== null && resource.type !== "form") throw new AccessError(404);
    const decision = await sharing.can(ctx, action, formId);
    // A missing scope is the caller's own limit and says nothing about the form, so it is 403.
    if (!decision.allowed) throw new AccessError(decision.role === undefined && hasScope(ctx.scopes, `form:${action}`) ? 404 : 403);
  };
  const forms = "/api/v1/forms";
  const checkId = async (c: Context, next: Next) => (FORM_ID.test(c.req.param("id") ?? "") ? next() : c.json({ error: "invalid_id" }, 400));
  app.use(`${forms}/:id`, checkId);
  app.use(`${forms}/:id/*`, checkId);
  app.post(forms, async (c) => {
    const ctx = c.get("ctx");
    if (!hasScope(ctx.scopes, "form:write")) throw new AccessError(403);
    const { publish, ...spec } = await c.req.json();
    const parsed = ops.check(spec);
    if (await repo.get(parsed.id)) throw new OpsError("conflict", `form "${parsed.id}" already exists`);
    // The owner row comes first. It fails if another request took the id, and nothing is stored then.
    try {
      await sharing.createResource(ctx, { id: parsed.id, type: "form" });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "resource exists") throw error;
      // An owner row with no form is what a failed create leaves. Its owner may finish the job.
      const resource = await store.get("resources", parsed.id);
      const adopt = resource?.type === "form" && (await sharing.can(ctx, "admin", parsed.id)).allowed && !(await repo.get(parsed.id));
      if (!adopt) throw new OpsError("conflict", `form "${parsed.id}" already exists`);
    }
    return c.json(await ops.create(parsed, publish === true, by(ctx)), 201);
  });
  // Lists the forms the caller's grants name. It reads the grants of the root of the chain,
  // so a list does not write one audit row per form. Scopes still narrow what an agent sees.
  // sharing.can writes an audit row for every check, allow or deny, so it cannot filter a list.
  // A person and an agent with the same id are two subjects, so the read names the kind too.
  app.get(forms, async (c) => {
    const ctx = c.get("ctx");
    const root = ctx.chain[0];
    if (root === undefined || !isSubjectKind(root.kind) || !hasScope(ctx.scopes, "form:read")) return c.json({ forms: [] });
    const visible: Form[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.query("grants", { where: { subjectKind: root.kind, subjectId: root.id }, orderBy: { field: "resourceId" }, cursor });
      for (const { data } of page.items) {
        if (typeof data.resourceId !== "string" || !ROLES.includes(data.role as Role)) continue;
        if ((await store.get("resources", data.resourceId))?.type !== "form") continue;
        const form = await repo.get(data.resourceId);
        if (form) visible.push(form);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return c.json({ forms: visible });
  });
  app.get(`${forms}/:id`, async (c) => {
    await require(c, "read", c.req.param("id"));
    return c.json(await ops.get(c.req.param("id")));
  });
  app.post(`${forms}/:id/questions`, async (c) => {
    await require(c, "write", c.req.param("id"));
    const { question, section } = await c.req.json();
    return c.json(await ops.addQuestion(c.req.param("id"), question, section, by(c.get("ctx"))), 201);
  });
  // Replaces the draft: edit, reorder, or remove questions. A published form starts a new draft version.
  app.put(`${forms}/:id`, async (c) => {
    await require(c, "write", c.req.param("id"));
    return c.json(await ops.update(c.req.param("id"), await c.req.json(), by(c.get("ctx"))));
  });
  app.post(`${forms}/:id/publish`, async (c) => {
    await require(c, "write", c.req.param("id"));
    // The body is optional: { expectedRevision } makes the publish refuse a draft that changed since the caller read it.
    const text = await c.req.text();
    const options = text.trim() === "" ? {} : publishBody.parse(JSON.parse(text));
    return c.json(await ops.publish(c.req.param("id"), options));
  });
  // Answers hold personal data, so reading them needs an editor.
  app.get(`${forms}/:id/responses`, async (c) => {
    await require(c, "write", c.req.param("id"));
    const raw = c.req.query("limit");
    const limit = raw === undefined ? undefined : Number(raw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
      return c.json({ error: "invalid_query", message: `limit is a whole number from 1 to ${MAX_LIMIT}` }, 400);
    }
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && !wellFormedCursor(cursor)) return c.json({ error: "invalid_query", message: "the cursor is not valid" }, 400);
    return c.json(await ops.listResponses(c.req.param("id"), { limit, cursor }));
  });
  app.get(`${forms}/:id/export`, async (c) => {
    await require(c, "write", c.req.param("id"));
    return c.body(await ops.exportCsv(c.req.param("id")), 200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" });
  });
  app.post(`${forms}/:id/purge`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    return c.json(await ops.purge(c.req.param("id")));
  });
  // Erases the form, its answers, and its grants, links, invites, and audit rows. Only an owner may.
  app.delete(`${forms}/:id`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    const id = c.req.param("id");
    // deleteResource refuses a resource with children or too many owners. Check first, so a refusal destroys nothing.
    if ((await store.query("resources", { where: { parentId: id }, limit: 1 })).items.length > 0) throw new OpsError("conflict", "the form has child resources");
    if ((await store.query("grants", { where: { resourceId: id, role: "owner" }, limit: MAX_OWNERS_ON_ERASE + 1 })).items.length > MAX_OWNERS_ON_ERASE) {
      throw new OpsError("conflict", `the form has more than ${MAX_OWNERS_ON_ERASE} owners`);
    }
    // The data goes first. A failed erase then leaves an owner who can run it again.
    // A check and a delete are two steps. A child made in between still refuses the delete, and the data is then gone. Run it again.
    const first = await ops.erase(id);
    await sharing.deleteResource(c.get("ctx"), id);
    // A submit that read the form before it went can land after the first pass.
    const second = await ops.erase(id);
    return c.json({ ok: true, erased: first.erased + second.erased });
  });
  app.post(`${forms}/:id/shares`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    const { subject, kind, role } = await c.req.json();
    if (typeof subject !== "string" || !SUBJECT.test(subject) || !isSubjectKind(kind) || !SHARE_ROLES.includes(role as Role)) {
      return c.json({ error: "invalid_share", message: `give a subject of letters, digits, "-" and "_", a kind of ${SUBJECT_KINDS.join(" or ")}, and a role of ${SHARE_ROLES.join(", ")}` }, 400);
    }
    // Identity guards the last owner too, but it ignores a grant with no kind. Check here as well. Two owners demoted at the same moment can still pass.
    if (role !== "owner") {
      const owners = (await store.query("grants", { where: { resourceId: c.req.param("id"), role: "owner" }, limit: 2 })).items;
      if (owners.length === 1 && owners[0]!.data.subjectId === subject && owners[0]!.data.subjectKind === kind) throw new OpsError("conflict", "the last owner cannot be removed");
    }
    try {
      await sharing.grant(c.get("ctx"), c.req.param("id"), { kind, id: subject }, role as Role);
    } catch (error) {
      if (error instanceof Error && error.message === "the last owner cannot be removed") throw new OpsError("conflict", error.message);
      throw error;
    }
    return c.json({ ok: true });
  });
  // Who holds a role on the form. Only an owner may ask. Pass `nextCursor` back as `cursor` to read on.
  app.get(`${forms}/:id/shares`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    const raw = c.req.query("limit");
    const limit = raw === undefined ? undefined : Number(raw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_PAGE)) {
      return c.json({ error: "invalid_query", message: `limit is a whole number from 1 to ${MAX_AUDIT_PAGE}` }, 400);
    }
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && !wellFormedCursor(cursor)) return c.json({ error: "invalid_query", message: "the cursor is not valid" }, 400);
    return c.json(await sharing.listGrants(c.get("ctx"), c.req.param("id"), { limit, cursor }));
  });
  app.delete(`${forms}/:id/shares/:subject`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    const kind = c.req.query("kind");
    if (!SUBJECT.test(c.req.param("subject")) || !isSubjectKind(kind)) {
      return c.json({ error: "invalid_share", message: `give a valid subject and ?kind=${SUBJECT_KINDS.join(" or ")}` }, 400);
    }
    try {
      await sharing.revokeGrant(c.get("ctx"), c.req.param("id"), { kind, id: c.req.param("subject") });
    } catch (error) {
      if (error instanceof Error && error.message === "the last owner cannot be removed") throw new OpsError("conflict", error.message);
      throw error;
    }
    return c.json({ ok: true });
  });
  // Invites and share links. An owner makes them. The role is editor or viewer, never owner: only a grant makes an owner.
  const pageOf = (c: Context): { limit?: number; cursor?: string } | Response => {
    const raw = c.req.query("limit");
    const limit = raw === undefined ? undefined : Number(raw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_PAGE)) {
      return c.json({ error: "invalid_query", message: `limit is a whole number from 1 to ${MAX_AUDIT_PAGE}` }, 400);
    }
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && !wellFormedCursor(cursor)) return c.json({ error: "invalid_query", message: "the cursor is not valid" }, 400);
    return { limit, cursor };
  };
  const invalidShare = (c: Context, message: string) => c.json({ error: "invalid_share", message }, 400);
  /** The role and the lifetime that an invite or a link takes, or a 400. */
  const shareTerms = (body: Record<string, unknown>): { role: "editor" | "viewer"; expiresInMs?: number } | string => {
    if (body.role !== "editor" && body.role !== "viewer") return "give a role of editor or viewer";
    const ms = body.expiresInMs;
    if (ms !== undefined && (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms <= 0 || !Number.isSafeInteger(now() + ms))) return "expiresInMs is a whole number of milliseconds above 0, and it ends at a time that fits";
    return { role: body.role, ...(ms === undefined ? {} : { expiresInMs: ms }) };
  };
  const readBody = async (c: Context): Promise<Record<string, unknown>> => {
    const body = await c.req.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  };
  app.post(`${forms}/:id/invites`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    const body = await readBody(c);
    const terms = shareTerms(body);
    if (typeof terms === "string") return invalidShare(c, terms);
    const { email, handle } = body;
    if ((email === undefined) === (handle === undefined)) return invalidShare(c, "give an email or a handle, not both");
    if (email !== undefined && (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email))) return invalidShare(c, "email is not valid: it has one @ and at most 254 characters");
    if (handle !== undefined && (typeof handle !== "string" || !HANDLE.test(handle))) return invalidShare(c, "handle is a lowercase letter, then 1 to 31 of a-z, 0-9, \"-\" and \"_\"");
    return c.json(await sharing.createInvite(c.get("ctx"), c.req.param("id"), { ...terms, ...(email === undefined ? { handle: handle as string } : { email: email as string }) }), 201);
  });
  // An invite shows no email: it says whether it is for an email or a handle.
  app.get(`${forms}/:id/invites`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    const page = pageOf(c);
    if (page instanceof Response) return page;
    const listed = await sharing.listInvites(c.get("ctx"), c.req.param("id"), page);
    // An invite made by agentic-identity may carry commenter, which this API does not make but the library honors: list it. Owner and unknown roles are refused by the library, so they are not listed.
    return c.json({ ...listed, invites: listed.invites.filter((invite) => LISTED_ROLES.has(invite.role)) });
  });
  // The token shows once, in this reply. Only its hash is stored.
  app.post(`${forms}/:id/links`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    const body = await readBody(c);
    const terms = shareTerms(body);
    if (typeof terms === "string") return invalidShare(c, terms);
    if (body.signedInOnly !== undefined && typeof body.signedInOnly !== "boolean") return invalidShare(c, "signedInOnly is true or false");
    return c.json(await sharing.createLink(c.get("ctx"), c.req.param("id"), {
      role: terms.role,
      signedInOnly: body.signedInOnly === true,
      ...(terms.expiresInMs === undefined ? {} : { expiresAt: now() + terms.expiresInMs }),
    }), 201);
  });
  // The links of the form, without the token or its hash.
  app.get(`${forms}/:id/links`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    const page = pageOf(c);
    if (page instanceof Response) return page;
    const rows = await store.query("links", { where: { resourceId: c.req.param("id") }, ...page });
    // A row with no id, a role that a link cannot give, or an expiry that is not a number is refused by the library, so it is not listed. A commenter link is honored, so it is.
    const links = rows.items.filter(({ data: d }) => typeof d.id === "string" && LISTED_ROLES.has(d.role as string) && (d.expiresAt === undefined || (typeof d.expiresAt === "number" && Number.isFinite(d.expiresAt)))).map(({ data: d }) => ({
      id: d.id as string,
      role: d.role as "viewer" | "commenter" | "editor",
      signedInOnly: d.signedInOnly === true,
      ...(typeof d.expiresAt === "number" ? { expiresAt: d.expiresAt } : {}),
      ...(d.revokedAt != null ? { revokedAt: typeof d.revokedAt === "number" ? d.revokedAt : 0 } : {}),
    }));
    return c.json({ links, ...(rows.nextCursor === undefined ? {} : { nextCursor: rows.nextCursor }) });
  });
  // A link of another form is 404 here, even for an owner of both.
  app.delete(`${forms}/:id/links/:link`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    const linkId = c.req.param("link");
    const link = SUBJECT.test(linkId) ? await store.get("links", linkId) : null;
    if (link === null || link.resourceId !== c.req.param("id")) throw new OpsError("not_found", "no such link on this form");
    // A second revoke keeps the first revoke time and writes no second audit entry.
    if (link.revokedAt == null) await sharing.revokeLink(c.get("ctx"), linkId);
    return c.json({ ok: true });
  });
  app.get(`${forms}/:id/audit`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    const raw = c.req.query("limit");
    const limit = raw === undefined ? undefined : Number(raw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_PAGE)) {
      return c.json({ error: "invalid_query", message: `limit is a whole number from 1 to ${MAX_AUDIT_PAGE}` }, 400);
    }
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && !wellFormedCursor(cursor)) return c.json({ error: "invalid_query", message: "the cursor is not valid" }, 400);
    return c.json(await sharing.listAudit(c.get("ctx"), c.req.param("id"), { limit, cursor }));
  });
  // Every form at once. Only a caller with the all-forms admin scope may run it.
  app.post("/api/v1/purge", async (c) => {
    if (!hasScope(c.get("ctx").scopes, "*:admin")) throw new AccessError(403);
    return c.json(await ops.purgeAll(now()));
  });

  // Rewrites grants made before grants had a kind. Until then they are not honored. Safe to run again.
  app.post("/api/v1/migrate-grants", async (c) => {
    if (!hasScope(c.get("ctx").scopes, "*:admin")) throw new AccessError(403);
    return c.json(await migrateGrants(store));
  });
  // For forms made before roles. Only a caller with the all-forms admin scope may run it.
  app.post("/api/v1/backfill-owners", async (c) => {
    if (!hasScope(c.get("ctx").scopes, "*:admin")) throw new AccessError(403);
    const body = await c.req.json();
    const { owner, cursor, limit } = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    // backfillOwners checks the owner, limit and cursor, and throws a BackfillError that onError maps to 400.
    return c.json(await ops.backfillOwners(owner as string, { cursor: cursor as string | undefined, limit: limit as number | undefined }));
  });

  app.onError((error, c) => {
    if (error instanceof AccessError) return c.json({ error: error.status === 404 ? "not_found" : "forbidden" }, error.status);
    if (error instanceof OpsError) return c.json({ error: error.kind, message: error.message }, error.kind === "not_found" ? 404 : 409);
    if (error instanceof VersionConflictError) return c.json({ error: "version_conflict", counts: error.counts, message: error.message }, 409);
    if (error instanceof EraseRefusedError) return c.json({ error: "conflict", message: error.message }, 409);
    if (error instanceof BackfillError) return c.json({ error: error.kind, message: error.message }, 400);
    if (error instanceof FormError || error instanceof SubmitError) return c.json({ error: "invalid", issues: error.issues }, 422);
    if (error instanceof ZodError) return c.json({ error: "invalid_spec", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    if (error instanceof SyntaxError) return c.json({ error: "bad_json" }, 400);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}

/** Reads the body as text and counts bytes as they arrive. Returns undefined, and stops reading, past the cap. */
async function readCapped(request: Request, cap: number): Promise<string | undefined> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
