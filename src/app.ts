import { Hono } from "hono";
import { ZodError } from "zod";
import { SubmitError } from "./core/responses.js";
import { FormError } from "./core/repo.js";
import type { Form } from "./core/form.js";
import { ROLES, createMemoryStore, createSharing, hasScope, type Action, type Auth, type PrincipalContext, type Role, type Store } from "agentic-identity";
import { clientKey, createRateLimiter } from "./core/rate-limit.js";
import { OpsError, createOps } from "./ops.js";
import { renderFillPage } from "./page.js";
import { VERSION } from "./version.js";

const MAX_BODY = 65_536;
const SHARE_ROLES: readonly Role[] = ["owner", "editor", "viewer"];

/** The caller may not do this. A caller with no role on the form gets 404, so a form id never leaks. */
class AccessError extends Error {
  constructor(readonly status: 403 | 404) {
    super("forbidden");
  }
}

export interface AppOptions {
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
  "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
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
  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

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
    const ctx = await options.auth.authenticate(c.req.raw);
    if (!ctx || ctx.chain.length === 0) return c.json({ error: "unauthorized" }, 401);
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
    return c.json(await ops.create(parsed, publish === true), 201);
  });
  // Lists the forms the caller's grants name. It reads the grants of the root of the chain,
  // so a list does not write one audit row per form. Scopes still narrow what an agent sees.
  // sharing.can writes an audit row for every check, allow or deny, so it cannot filter a list.
  // identity 0.2.0 has no call to list the resources of a subject.
  app.get(forms, async (c) => {
    const ctx = c.get("ctx");
    const root = ctx.chain[0]?.id;
    if (root === undefined || !hasScope(ctx.scopes, "form:read")) return c.json({ forms: [] });
    const visible: Form[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.query("grants", { where: { subjectId: root }, orderBy: { field: "resourceId" }, cursor });
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
    return c.json(await ops.addQuestion(c.req.param("id"), question, section), 201);
  });
  app.post(`${forms}/:id/publish`, async (c) => {
    await require(c, "write", c.req.param("id"));
    return c.json(await ops.publish(c.req.param("id")));
  });
  // Answers hold personal data, so reading them needs an editor.
  app.get(`${forms}/:id/responses`, async (c) => {
    await require(c, "write", c.req.param("id"));
    const limit = c.req.query("limit");
    return c.json(await ops.listResponses(c.req.param("id"), { limit: limit ? Number(limit) : undefined, cursor: c.req.query("cursor") }));
  });
  app.get(`${forms}/:id/export`, async (c) => {
    await require(c, "write", c.req.param("id"));
    return c.body(await ops.exportCsv(c.req.param("id")), 200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" });
  });
  app.post(`${forms}/:id/purge`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    return c.json(await ops.purge(c.req.param("id")));
  });
  app.post(`${forms}/:id/shares`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    const { subject, role } = await c.req.json();
    if (typeof subject !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(subject) || !SHARE_ROLES.includes(role as Role)) {
      return c.json({ error: "invalid_share", message: `give a subject of letters, digits, "-" and "_", and a role of ${SHARE_ROLES.join(", ")}` }, 400);
    }
    // identity's grant() does not guard the last owner, so check here. Two owners demoted at the same moment can still pass.
    if (role !== "owner") {
      const owners = (await store.query("grants", { where: { resourceId: c.req.param("id"), role: "owner" }, limit: 2 })).items;
      if (owners.length === 1 && owners[0]!.data.subjectId === subject) throw new OpsError("conflict", "the last owner cannot be removed");
    }
    await sharing.grant(c.get("ctx"), c.req.param("id"), subject, role as Role);
    return c.json({ ok: true });
  });
  app.delete(`${forms}/:id/shares/:subject`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    try {
      await sharing.revokeGrant(c.get("ctx"), c.req.param("id"), c.req.param("subject"));
    } catch (error) {
      if (error instanceof Error && error.message === "the last owner cannot be removed") throw new OpsError("conflict", error.message);
      throw error;
    }
    return c.json({ ok: true });
  });
  app.get(`${forms}/:id/audit`, async (c) => {
    await require(c, "admin", c.req.param("id"));
    return c.json({ entries: await sharing.listAudit(c.get("ctx"), c.req.param("id")) });
  });
  // Every form at once. Only a caller with the all-forms admin scope may run it.
  app.post("/api/v1/purge", async (c) => {
    if (!hasScope(c.get("ctx").scopes, "*:admin")) throw new AccessError(403);
    return c.json(await ops.purgeAll(now()));
  });

  app.onError((error, c) => {
    if (error instanceof AccessError) return c.json({ error: error.status === 404 ? "not_found" : "forbidden" }, error.status);
    if (error instanceof OpsError) return c.json({ error: error.kind, message: error.message }, error.kind === "not_found" ? 404 : 409);
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
