import { closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createMemoryStore, type Dump, type Store } from "./store.js";

export interface FileStoreOptions {
  /** A lock older than this is taken over, even if its owner looks alive. Default 10 seconds. */
  staleMs?: number;
  /** How long one operation waits for the lock before it fails. Default 30 seconds. */
  waitMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when no process has this id. Any other result, including no permission, counts as alive. */
function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * A Store kept in one JSON file, safe for several processes. Every operation
 * takes a lock file, reads the file again, applies the change to that fresh
 * copy, and saves it with a write to a unique temp file and a rename. A read
 * also reads the file again, so a long-running process sees other writers.
 */
export function createFileStore(path: string, options: FileStoreOptions = {}): Store {
  const staleMs = options.staleMs ?? 10_000;
  const waitMs = options.waitMs ?? 30_000;
  const lockPath = `${path}.lock`;
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;

  const load = (): Dump | undefined => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Dump) : undefined);
  const save = (data: Dump) => {
    const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    renameSync(temp, path);
  };

  /** Judges a lock from its content and age. Content that cannot be read counts as live until it is old. */
  const isStale = (content: string, modified: number): boolean => {
    if (Date.now() - modified > staleMs) return true;
    const pid = Number(/^(\d+):/.exec(content)?.[1]);
    return Number.isInteger(pid) && pid > 0 && isDead(pid);
  };

  /** Moves a stale lock aside. The rename is atomic, so one process wins. A lock that changed in between is put back. */
  const takeOver = (seen: string) => {
    const aside = `${lockPath}.stale.${process.pid}.${randomBytes(6).toString("hex")}`;
    try {
      renameSync(lockPath, aside);
    } catch {
      return;
    }
    try {
      if (readFileSync(aside, "utf8") !== seen) {
        // This was a newer lock, not the stale one. Restore it unless another already exists.
        try {
          linkSync(aside, lockPath);
        } catch {}
      }
    } finally {
      try {
        unlinkSync(aside);
      } catch {}
    }
  };

  const acquire = async () => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        try {
          writeFileSync(fd, `${token}:${Date.now()}`);
        } finally {
          closeSync(fd);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        const content = readFileSync(lockPath, "utf8");
        if (isStale(content, statSync(lockPath).mtimeMs)) {
          takeOver(content);
          continue;
        }
      } catch {
        continue; // The lock went away between the two calls. Try to take it.
      }
      if (Date.now() > deadline) throw new Error(`could not lock "${path}" within ${waitMs} ms`);
      await sleep(20 + Math.random() * 30);
    }
  };

  const release = () => {
    try {
      if (readFileSync(lockPath, "utf8").startsWith(token)) unlinkSync(lockPath);
    } catch {}
  };

  // One operation at a time inside this process; the lock file covers other processes.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <R>(run: () => Promise<R>): Promise<R> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };

  /** Runs one store call on a fresh copy of the file. A write saves the result before the lock is released. */
  const withFresh = <R>(locked: boolean, use: (store: Store) => Promise<R>): Promise<R> =>
    exclusive(async () => {
      if (locked) await acquire();
      try {
        return await use(createMemoryStore({ initial: load(), onWrite: locked ? save : undefined }));
      } finally {
        if (locked) release();
      }
    });

  return {
    region: "eu",
    get: (c, id) => withFresh(false, (s) => s.get(c, id)),
    query: (c, q) => withFresh(false, (s) => s.query(c, q)),
    put: (c, id, doc) => withFresh(true, (s) => s.put(c, id, doc)),
    delete: (c, id) => withFresh(true, (s) => s.delete(c, id)),
    transaction: (fn) => withFresh(true, (s) => s.transaction(fn)),
  };
}
