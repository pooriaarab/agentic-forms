import type { Doc, Query, Store } from "agentic-identity";

/** The most one run reads and deletes. A Worker run has a cap on database calls, so a backlog is cleared over several runs. */
export interface PurgeBudget {
  /** Pages one pass reads. */
  pages: number;
  /** Docs per page. One page is one transaction. */
  size: number;
}

export const DEFAULT_PURGE_BUDGET: PurgeBudget = { pages: 10, size: 50 };

/**
 * Reads a collection in the order of `query` and deletes docs while `dead`
 * says so. It stops at the first doc that is not dead, so a collection of live
 * docs costs one read. An `orderBy` field leaves out docs that lack it or hold
 * null, so pair it with a pass that has no `orderBy` for those. Returns the count.
 */
export async function purgeOrdered(
  store: Store,
  collection: string,
  query: Pick<Query, "where" | "orderBy">,
  dead: (doc: Doc) => boolean,
  budget: PurgeBudget = DEFAULT_PURGE_BUDGET,
): Promise<number> {
  let purged = 0;
  for (let page = 0; page < budget.pages; page++) {
    const { deleted, last } = await store.transaction(async (tx) => {
      const found = await tx.query(collection, { ...query, limit: budget.size });
      const doomed: string[] = [];
      for (const { id, data } of found.items) {
        if (!dead(data)) break;
        doomed.push(id);
      }
      for (const id of doomed) await tx.delete(collection, id);
      return { deleted: doomed.length, last: doomed.length < budget.size };
    });
    purged += deleted;
    if (last) break;
  }
  return purged;
}
