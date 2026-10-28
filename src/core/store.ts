// A local copy of the Store port shape from agentic-identity, with an
// in-memory adapter. Equality filters, one orderBy, limit, cursor, and
// transactions. Replace this file with the import when that package ships.
export type Region = "eu" | "us" | "any";

export type Scalar = string | number | boolean | null;
export type Json = Scalar | Json[] | { [key: string]: Json };
export type Doc = { [key: string]: Json };

export interface Entry<T extends Doc = Doc> {
  id: string;
  data: T;
}

export interface Query {
  where?: Record<string, Scalar>;
  orderBy?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  cursor?: string;
}

export interface Page<T extends Doc = Doc> {
  items: Entry<T>[];
  nextCursor?: string;
}

export const DEFAULT_LIMIT = 100;

export interface StoreOps {
  get<T extends Doc = Doc>(collection: string, id: string): Promise<T | null>;
  put<T extends Doc = Doc>(collection: string, id: string, doc: T): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  query<T extends Doc = Doc>(collection: string, query?: Query): Promise<Page<T>>;
}

export interface Store extends StoreOps {
  readonly region: Region;
  transaction<R>(fn: (tx: StoreOps) => Promise<R>): Promise<R>;
}

function assertCollection(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error(`invalid collection name "${name}"`);
}

function assertId(id: string): void {
  if (id.length === 0 || id.length > 256 || id.includes("/")) throw new Error(`invalid id "${id}"`);
}

type Tables = Map<string, Map<string, Doc>>;

const compare = (a: Json, b: Json): number =>
  typeof a !== typeof b ? (typeof a < typeof b ? -1 : 1) : (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;

function storeOps(tables: Tables): StoreOps {
  return {
    async get<T extends Doc>(collection: string, id: string) {
      assertCollection(collection);
      assertId(id);
      const doc = tables.get(collection)?.get(id);
      return doc ? (JSON.parse(JSON.stringify(doc)) as T) : null;
    },
    async put(collection, id, doc) {
      assertCollection(collection);
      assertId(id);
      const copy = JSON.parse(JSON.stringify(doc)) as Doc;
      if (!tables.has(collection)) tables.set(collection, new Map());
      tables.get(collection)!.set(id, copy);
    },
    async delete(collection, id) {
      assertCollection(collection);
      assertId(id);
      tables.get(collection)?.delete(id);
    },
    async query<T extends Doc>(collection: string, query: Query = {}): Promise<Page<T>> {
      assertCollection(collection);
      const limit = query.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer of 1 or more");
      const sign = query.orderBy?.direction === "desc" ? -1 : 1;
      const field = query.orderBy?.field;
      const order = (x: { v: Json; id: string }, y: { v: Json; id: string }) => sign * (compare(x.v, y.v) || compare(x.id, y.id));
      let rows = [...(tables.get(collection) ?? [])]
        .filter(([, doc]) => Object.entries(query.where ?? {}).every(([k, v]) => k in doc && doc[k] === v))
        .map(([id, doc]) => ({ id, doc, v: (field === undefined ? id : doc[field]) as Json }))
        .filter((row) => row.v !== undefined && row.v !== null)
        .sort(order);
      if (query.cursor !== undefined) {
        let after: { v: Json; id: string };
        try {
          const [v, id] = JSON.parse(decodeURIComponent(query.cursor)) as [Json, string];
          if (typeof id !== "string") throw new Error();
          after = { v, id };
        } catch {
          throw new Error("invalid cursor");
        }
        rows = rows.filter((row) => order(row, after) > 0);
      }
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((row) => ({ id: row.id, data: JSON.parse(JSON.stringify(row.doc)) as T })),
        ...(rows.length > limit && last ? { nextCursor: encodeURIComponent(JSON.stringify([last.v, last.id])) } : {}),
      };
    },
  };
}

export type Dump = Record<string, Record<string, Doc>>;

export interface MemoryStoreOptions {
  region?: Region;
  /** Docs to start with. */
  initial?: Dump;
  /** Called with all data after each write. A file store saves here. */
  onWrite?: (data: Dump) => void;
}

export function createMemoryStore(options: MemoryStoreOptions = {}): Store {
  let tables: Tables = new Map(Object.entries(options.initial ?? {}).map(([name, docs]) => [name, new Map(Object.entries(docs))]));
  const dump = (): Dump => Object.fromEntries([...tables].map(([name, docs]) => [name, Object.fromEntries(docs)]));
  let lock: Promise<unknown> = Promise.resolve();
  // One operation at a time, so a transaction sees no other writer.
  const exclusive = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };
  return {
    region: options.region ?? "eu",
    get: (c, id) => exclusive(() => storeOps(tables).get(c, id)),
    put: (c, id, doc) => exclusive(() => storeOps(tables).put(c, id, doc).then(() => options.onWrite?.(dump()))),
    delete: (c, id) => exclusive(() => storeOps(tables).delete(c, id).then(() => options.onWrite?.(dump()))),
    query: (c, q) => exclusive(() => storeOps(tables).query(c, q)),
    transaction: (fn) =>
      exclusive(async () => {
        const draft: Tables = new Map([...tables].map(([name, docs]) => [name, new Map(docs)]));
        const result = await fn(storeOps(draft));
        tables = draft;
        options.onWrite?.(dump());
        return result;
      }),
  };
}

