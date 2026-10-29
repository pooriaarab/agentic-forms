// The file store is a Store adapter, so it passes the shared contract suite.
import { runStoreContract } from "agentic-identity/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createFileStore } from "./file-store.js";

const dir = mkdtempSync(join(tmpdir(), "forms-contract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Stores with the same `shared` name use one file. Others get a file of their own.
runStoreContract((options) => createFileStore(join(dir, `${options.shared ?? crypto.randomUUID()}.json`), options));
