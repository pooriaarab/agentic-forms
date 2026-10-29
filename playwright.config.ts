// Drives the web UI in a real browser against `wrangler dev`. Run `npm run test:ui`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export const PORT = 8890; // the Worker and client e2e files use 8799 to 8870
export const TOKEN = "e2e-ui-token-0123456789-0123456789-0123";
const RATE_SECRET = "e2e-ui-rate-secret-0123456789-0123456789";

export default defineConfig({
  testDir: "e2e-ui",
  timeout: 240_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1280, height: 800 }, acceptDownloads: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port ${PORT} --inspector-port 9340 --persist-to ${mkdtempSync(join(tmpdir(), "forms-ui-d1-"))} --var FORMS_REGION:unknown --var FORMS_UNSAFE_LOCAL_REGION:1 --var FORMS_RATE_SECRET:${RATE_SECRET} --var FORMS_API_TOKEN:${TOKEN}`,
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { WRANGLER_SEND_METRICS: "false", CI: "1" },
  },
});
