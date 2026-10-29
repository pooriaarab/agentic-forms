import { createD1Store, D1_SCHEMA, type D1Like } from "agentic-identity/cloudflare";
import { parseRegion } from "agentic-identity";
import { createApp } from "./app.js";
import { createOps } from "./ops.js";

export interface WorkerEnv {
  /** The D1 database. Create it in the EU: wrangler d1 create agentic-forms --location weur */
  DB: D1Like;
  /** Where the database lives: "eu" or "us". It is a claim by the operator and has no default. */
  FORMS_REGION?: string;
  /** Set it as a secret: wrangler secret put FORMS_API_TOKEN. */
  FORMS_API_TOKEN?: string;
}

// One app per isolate. A failed start is not kept, so the next request tries again.
let running: Promise<{ app: ReturnType<typeof createApp>; ops: ReturnType<typeof createOps> }> | undefined;

async function start(env: WorkerEnv) {
  const region = parseRegion(env.FORMS_REGION);
  if (region === "unknown") throw new Error('FORMS_REGION must be "eu" or "us"');
  await env.DB.prepare(D1_SCHEMA).run();
  const store = createD1Store(env.DB, { region });
  return { app: createApp({ store, apiToken: env.FORMS_API_TOKEN }), ops: createOps(store) };
}

const ready = (env: WorkerEnv) =>
  (running ??= start(env).catch((error: unknown) => {
    running = undefined;
    throw error;
  }));

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return (await ready(env)).app.fetch(request);
  },
  /** The Cron Trigger. A failure is thrown so the run shows as failed. It logs counts only. */
  async scheduled(_controller: unknown, env: WorkerEnv): Promise<void> {
    console.log(JSON.stringify({ event: "purge", ...(await (await ready(env)).ops.purgeAll()) }));
  },
};
