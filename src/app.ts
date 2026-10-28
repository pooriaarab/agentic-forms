import { Hono } from "hono";
import { SubmitError, createResponses } from "./core/responses.js";
import { createFormRepo } from "./core/repo.js";
import { createMemoryStore, type Store } from "./core/store.js";
import { renderFillPage } from "./page.js";
import { VERSION } from "./version.js";

const MAX_BODY = 65_536;

export interface AppOptions {
  store?: Store;
  /** Submits allowed per client in each window. Defaults to 20 a minute. Pass `false` to turn it off. */
  rateLimit?: { limit: number; windowMs: number } | false;
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
  const repo = createFormRepo(store);
  const responses = createResponses(store, repo);
  const now = options.now ?? Date.now;
  const limit = options.rateLimit === false ? undefined : (options.rateLimit ?? { limit: 20, windowMs: 60_000 });
  // Client keys live in memory only. They are never stored or logged.
  const hits = new Map<string, { count: number; start: number }>();

  const retryAfter = (key: string): number => {
    if (!limit) return 0;
    const t = now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start >= limit.windowMs) hits.delete(k);
    const hit = hits.get(key);
    if (!hit || t - hit.start >= limit.windowMs) {
      hits.set(key, { count: 1, start: t });
      return 0;
    }
    hit.count++;
    return hit.count > limit.limit ? Math.ceil((hit.start + limit.windowMs - t) / 1000) : 0;
  };

  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

  app.get("/f/:id", async (c) => {
    const form = await repo.getPublished(c.req.param("id"));
    if (!form) return c.text("This form is not available.", 404);
    const nonce = crypto.randomUUID();
    return c.html(renderFillPage(form, nonce), 200, PAGE_HEADERS(nonce));
  });

  app.post("/f/:id", async (c) => {
    const wait = retryAfter(c.req.header("cf-connecting-ip") ?? "unknown");
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
