import { createApp } from "./app.js";

export interface WorkerEnv {
  /** Set it as a secret: wrangler secret put FORMS_API_TOKEN. */
  FORMS_API_TOKEN?: string;
}

// One in-memory store per isolate until a D1 adapter ships. Data is lost on restart.
let app: ReturnType<typeof createApp> | undefined;

export default {
  fetch(request: Request, env: WorkerEnv): Response | Promise<Response> {
    app ??= createApp({ apiToken: env.FORMS_API_TOKEN });
    return app.fetch(request);
  },
};
