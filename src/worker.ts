import { createD1Store, D1_SCHEMA, type D1Like } from "agentic-identity/cloudflare";
import { parseRegion, type Store } from "agentic-identity";
import { createApp } from "./app.js";
import { createTokenAuth } from "./core/token-auth.js";
import { createOps } from "./ops.js";

export interface WorkerEnv {
  /** The D1 database. Create it in the EU: wrangler d1 create agentic-forms --location weur */
  DB: D1Like;
  /** Where the database lives: "eu" or "us". It is a claim by the operator and has no default. */
  FORMS_REGION?: string;
  /** Set it as a secret: wrangler secret put FORMS_RATE_SECRET. At least 32 bytes. It keys the hash of client addresses. */
  FORMS_RATE_SECRET?: string;
  /** Set it as a secret: wrangler secret put FORMS_API_TOKEN. */
  FORMS_API_TOKEN?: string;
}

// One store per isolate. A failed start is not kept, so the next request tries again.
let storing: Promise<{ store: Store; ops: ReturnType<typeof createOps> }> | undefined;
let serving: Promise<ReturnType<typeof createApp>> | undefined;

async function openStore(env: WorkerEnv) {
  const region = parseRegion(env.FORMS_REGION);
  if (region === "unknown") throw new Error('FORMS_REGION must be "eu" or "us"');
  await env.DB.prepare(D1_SCHEMA).run();
  const store = createD1Store(env.DB, { region });
  return { store, ops: createOps(store) };
}

const forget = <T>(work: Promise<T>, reset: () => void) =>
  work.catch((error: unknown) => {
    reset();
    throw error;
  });

const database = (env: WorkerEnv) => (storing ??= forget(openStore(env), () => (storing = undefined)));
// The app is separate, so a bad API token or rate secret stops requests and not the purge job.
const app = (env: WorkerEnv) =>
  (serving ??= forget(
    database(env).then(({ store }) => createApp({ store, auth: env.FORMS_API_TOKEN === undefined ? undefined : createTokenAuth(env.FORMS_API_TOKEN), rateLimitSecret: env.FORMS_RATE_SECRET })),
    () => (serving = undefined),
  ));

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return (await app(env)).fetch(request);
  },
  /** The Cron Trigger. A failure is thrown so the run shows as failed. It logs counts only. */
  async scheduled(_controller: unknown, env: WorkerEnv): Promise<void> {
    console.log(JSON.stringify({ event: "purge", ...(await (await database(env)).ops.purgeAll()) }));
  },
};
