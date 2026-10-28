import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createMemoryStore, type Dump, type Store } from "./store.js";

/** A Store kept in one JSON file. For the CLI and local use. Each write replaces the file. */
export function createFileStore(path: string): Store {
  const initial = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Dump) : undefined;
  return createMemoryStore({
    initial,
    onWrite: (data) => {
      writeFileSync(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    },
  });
}
