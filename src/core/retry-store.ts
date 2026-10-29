import { StoreConflictError, type AdapterOptions, type Store } from "agentic-identity";
import { createFileStore as createIdentityFileStore } from "agentic-identity/file";

const ATTEMPTS = 200;
/** The file store of agentic-identity fails a write when another process wrote the file first. Nothing was written, so the call can run again. */
const lostRace = (error: unknown) => error instanceof StoreConflictError && /store file/.test(error.message);

async function again<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= ATTEMPTS || !lostRace(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * Math.min(attempt, 10)));
    }
  }
}

/** Runs a Store call again when another process won the race for the data file. A version conflict still fails at once. */
export function retryingStore(store: Store): Store {
  return {
    region: store.region,
    get: (c, id) => again(() => store.get(c, id)),
    query: (c, q) => again(() => store.query(c, q)),
    put: (c, id, doc) => again(() => store.put(c, id, doc)),
    delete: (c, id) => again(() => store.delete(c, id)),
    transaction: (fn) => again(() => store.transaction(fn)),
  };
}

/** The store of agentic-identity on one JSON file, safe for several processes. Same call as before: a path, then options. */
export const createFileStore = (path: string, options: AdapterOptions = {}): Store => retryingStore(createIdentityFileStore({ ...options, path }));
