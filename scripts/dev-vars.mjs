// Create .dev.vars for `wrangler dev` if it is missing. The Worker needs a rate limit
// secret of 32 bytes or more and has no default, so this writes a fresh random one.
// The file is git-ignored and works on this machine only.
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const file = new URL("../.dev.vars", import.meta.url);
if (!existsSync(file)) {
  writeFileSync(file, `FORMS_RATE_SECRET=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  console.log("wrote .dev.vars with a random FORMS_RATE_SECRET");
}
