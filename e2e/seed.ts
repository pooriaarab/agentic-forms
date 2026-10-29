// Writes one principal and one credential into a local D1 directory, the way
// issueCredential does, so a test can call the Worker with a bearer token.
// The token itself is never stored: the row key is its SHA-256.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const WRANGLER = "node_modules/.bin/wrangler";
const SCHEMA = "CREATE TABLE IF NOT EXISTS store_docs (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (collection, id)) WITHOUT ROWID";
const json = (value: object) => JSON.stringify(value).replace(/'/g, "''");

/** The SQL that makes the table and a principal "ada" (a person unless `kind` says agent) with this token. Scopes default to all rights. */
export function seedSql(token: string, scopes: string[] = ["*:admin"], id = "ada", kind: "human" | "agent" = "human"): string {
  const hash = createHash("sha256").update(token).digest("hex");
  return `${SCHEMA}; INSERT OR REPLACE INTO store_docs (collection, id, body, version) VALUES ('principals', '${id}', '${json({ id, kind, scopes })}', 1), ('credentials', '${hash}', '${json({ principalId: id, kind: "session" })}', 1)`;
}

export const wranglerArgs = (persist: string, sql: string) => ["d1", "execute", "DB", "--local", "--persist-to", persist, "--json", "--command", sql];

export function seed(persist: string, token: string, scopes?: string[], id?: string, kind?: "human" | "agent"): void {
  execFileSync(WRANGLER, wranglerArgs(persist, seedSql(token, scopes, id, kind)), { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } });
}
