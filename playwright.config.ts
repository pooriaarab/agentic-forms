// Drives the web UI in a real browser against `wrangler dev`. Run `npm run test:ui`.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { seedSql } from "./e2e/seed.js";

export const PORT = 8890; // the Worker and client e2e files use 8799 to 8870
export const TOKEN = "e2e-ui-token-0123456789-0123456789-0123";
const RATE_SECRET = "e2e-ui-rate-secret-0123456789-0123456789";
const PERSIST = mkdtempSync(join(tmpdir(), "forms-ui-d1-"));
// The token is a credential kept in the store: write it first, then start the Worker on the same data.
const SEED_FILE = join(PERSIST, "seed.sql");
writeFileSync(SEED_FILE, seedSql(TOKEN, undefined, "bot", "agent")); // an agent, so the builder shows the agent mark
const SEED = `node_modules/.bin/wrangler d1 execute DB --local --persist-to ${PERSIST} --file ${SEED_FILE}`;

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
    command: `${SEED} && node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port ${PORT} --inspector-port 9340 --persist-to ${PERSIST} --var FORMS_REGION:unknown --var FORMS_UNSAFE_LOCAL_REGION:1 --var FORMS_RATE_SECRET:${RATE_SECRET}`,
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { WRANGLER_SEND_METRICS: "false", CI: "1" },
  },
});
