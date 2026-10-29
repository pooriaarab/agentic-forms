import { defineConfig } from "tsup";

export default defineConfig({
  // Named entries, so `ui/embed.tsx` lands next to the others as `dist/embed.js`.
  entry: { index: "src/index.ts", cli: "src/cli.ts", worker: "src/worker.ts", client: "src/client.ts", embed: "ui/embed.tsx" },
  format: ["esm"],
  dts: true,
  clean: true,
});
