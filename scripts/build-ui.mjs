// Builds the web UI into public/ui. The Worker serves that folder as static assets.
// The design package stays in node_modules: its stylesheet and fonts are copied, not vendored.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const out = "public/ui";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ["ui/main.tsx"],
  outfile: `${out}/app.js`,
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
const design = "node_modules/agentic-design/dist";
cpSync(`${design}/styles.css`, `${out}/styles.css`);
cpSync(`${design}/fonts`, `${out}/fonts`, { recursive: true });
cpSync("ui/app.css", `${out}/app.css`);
cpSync("ui/_headers", "public/_headers");
cpSync("ui/index.html", `${out}/index.html`);
