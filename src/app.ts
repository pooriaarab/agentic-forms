import { Hono } from "hono";
import { ZodError } from "zod";
import { SubmitError } from "./core/responses.js";
import { FormError } from "./core/repo.js";
import { createMemoryStore, type Store } from "agentic-identity";
import { createRateLimiter } from "./core/rate-limit.js";
import { OpsError, createOps } from "./ops.js";
import { renderFillPage } from "./page.js";
import { VERSION } from "./version.js";

const MAX_BODY = 65_536;
const MIN_TOKEN_BYTES = 32;

export interface AppOptions {
  store?: Store;
  /** Bearer token for /api/v1, at least 32 bytes. createApp throws on a shorter one. With no token the API answers 503. There is no default. */
  apiToken?: string;
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
  if (options.apiToken !== undefined && new TextEncoder().encode(options.apiToken).length < MIN_TOKEN_BYTES) {
    throw new Error(`apiToken must be at least ${MIN_TOKEN_BYTES} bytes`);
  }
  const store = options.store ?? createMemoryStore();
  const ops = createOps(store);
  const { repo, responses } = ops;
  const now = options.now ?? Date.now;
  const limiter =
    options.rateLimit === false ? undefined : createRateLimiter(store, options.rateLimit ?? { limit: 20, windowMs: 60_000 }, options.rateLimitSecret as string, now);

  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

  app.get("/f/:id", async (c) => {
    const form = await repo.getPublished(c.req.param("id"));
    if (!form) return c.text("This form is not available.", 404);
    const nonce = crypto.randomUUID();
    return c.html(renderFillPage(form, nonce), 200, PAGE_HEADERS(nonce));
  });

  app.post("/f/:id", async (c) => {
    const wait = (await limiter?.hit(c.req.header("cf-connecting-ip") ?? "unknown")) ?? 0;
    if (wait > 0) return c.json({ error: "rate_limited" }, 429, { "retry-after": String(wait) });
    const id = c.req.param("id");
    if (!(await repo.getPublished(id))) return c.json({ error: "not_found" }, 404);
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
    if (!options.apiToken) return c.json({ error: "api_disabled" }, 503);
    if (!(await sameSecret(c.req.header("authorization") ?? "", `Bearer ${options.apiToken}`))) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  const forms = "/api/v1/forms";
  app.post(forms, async (c) => {
    const { publish, ...spec } = await c.req.json();
    return c.json(await ops.create(spec, publish === true), 201);
  });
  app.get(forms, async (c) => c.json({ forms: await repo.list() }));
  app.get(`${forms}/:id`, async (c) => c.json(await ops.get(c.req.param("id"))));
  app.post(`${forms}/:id/questions`, async (c) => {
    const { question, section } = await c.req.json();
    return c.json(await ops.addQuestion(c.req.param("id"), question, section), 201);
  });
  app.post(`${forms}/:id/publish`, async (c) => c.json(await ops.publish(c.req.param("id"))));
  app.get(`${forms}/:id/responses`, async (c) => {
    const limit = c.req.query("limit");
    return c.json(await ops.listResponses(c.req.param("id"), { limit: limit ? Number(limit) : undefined, cursor: c.req.query("cursor") }));
  });
  app.get(`${forms}/:id/export`, async (c) =>
    c.body(await ops.exportCsv(c.req.param("id")), 200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" }),
  );
  app.post("/api/v1/purge", async (c) => c.json(await ops.purgeAll(now())));
  app.post(`${forms}/:id/purge`, async (c) => c.json(await ops.purge(c.req.param("id"))));

  app.onError((error, c) => {
    if (error instanceof OpsError) return c.json({ error: error.kind, message: error.message }, error.kind === "not_found" ? 404 : 409);
    if (error instanceof FormError || error instanceof SubmitError) return c.json({ error: "invalid", issues: error.issues }, 422);
    if (error instanceof ZodError) return c.json({ error: "invalid_spec", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    if (error instanceof SyntaxError) return c.json({ error: "bad_json" }, 400);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}

/** Compares two secrets in constant time by comparing their digests. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return x.reduce((diff, byte, i) => diff | (byte ^ y[i]), 0) === 0;
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
