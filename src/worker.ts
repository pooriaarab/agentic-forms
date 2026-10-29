import { createD1Store, D1_SCHEMA, type D1Like } from "agentic-identity/cloudflare";
import { parseRegion } from "agentic-identity";
import { createApp } from "./app.js";

export interface WorkerEnv {
  /** The D1 database. Create it in the EU: wrangler d1 create agentic-forms --location weur */
  DB: D1Like;
  /** Where the database lives: "eu" or "us". It is a claim by the operator and has no default. */
  FORMS_REGION?: string;
  /** Set it as a secret: wrangler secret put FORMS_API_TOKEN. */
  FORMS_API_TOKEN?: string;
}

// One app per isolate. A failed start is not kept, so the next request tries again.
let app: Promise<ReturnType<typeof createApp>> | undefined;

async function start(env: WorkerEnv) {
  const region = parseRegion(env.FORMS_REGION);
  await env.DB.prepare(D1_SCHEMA).run();
  return createApp({ store: createD1Store(env.DB, { region }), apiToken: env.FORMS_API_TOKEN });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    app ??= start(env).catch((error: unknown) => {
      app = undefined;
      throw error;
    });
    return (await app).fetch(request);
  },
};
