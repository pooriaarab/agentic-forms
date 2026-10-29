import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "ui/**/*.test.tsx", "e2e/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The E2E run leaves a repeatable artifact: names, statuses, and durations only.
    reporters: ["default", "json"],
    outputFile: { json: "e2e-report.json" },
    environment: "node",
  },
});
