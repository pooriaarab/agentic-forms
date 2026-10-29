import { createSharing, type PrincipalContext, type Store } from "agentic-identity";
import { createFormRepo } from "./repo.js";

const OWNER = /^[A-Za-z0-9_-]{1,128}$/;

export interface BackfillResult {
  /** Forms that got an owner row now. */
  created: string[];
  /** How many forms already had a resource row. They are not touched. */
  skipped: number;
  /** Forms whose id is held by a resource of another type. They need a person to decide. */
  conflicts: string[];
}

/**
 * Forms made before roles have no resource row and no owner. Nobody but the
 * deployment can reach them. This gives each of them one owner row for `owner`.
 * It is safe to run again: a form with a resource row is left as it is, and the
 * row and the grant are written in one transaction.
 */
export async function backfillOwners(store: Store, owner: string): Promise<BackfillResult> {
  if (typeof owner !== "string" || !OWNER.test(owner)) throw new Error('the owner is a principal id of letters, digits, "-" and "_"');
  const sharing = createSharing(store);
  const ctx: PrincipalContext = { principalId: owner, kind: "human", chain: [{ id: owner, kind: "human" }], scopes: ["form:write"] };
  const result: BackfillResult = { created: [], skipped: 0, conflicts: [] };
  for (const form of await createFormRepo(store).list()) {
    const existing = await store.get("resources", form.id);
    if (existing === null) {
      try {
        await sharing.createResource(ctx, { id: form.id, type: "form" });
        result.created.push(form.id);
        continue;
      } catch (error) {
        // Another run took it between the read and the write.
        if (!(error instanceof Error) || error.message !== "resource exists") throw error;
      }
    }
    const type = (await store.get("resources", form.id))?.type;
    if (type === "form") result.skipped++;
    else result.conflicts.push(form.id);
  }
  return result;
}
