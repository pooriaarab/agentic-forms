import { createSharing, type PrincipalContext, type Store } from "agentic-identity";
import { FORM_ID, SUBJECT_ID, wellFormedCursor } from "./schema.js";

/** Forms per pass. Each form costs a few D1 calls, and one Worker request may make only so many. */
export const BACKFILL_PAGE = 25;

/** The caller gave a bad owner, limit or cursor. Nothing was written. */
export class BackfillError extends Error {
  constructor(
    readonly kind: "invalid_owner" | "invalid_query",
    message: string,
  ) {
    super(message);
    this.name = "BackfillError";
  }
}

export interface BackfillResult {
  /** Forms that got an owner row now. */
  created: string[];
  /** How many forms already had a resource row. They are not touched. */
  skipped: number;
  /** Forms whose id is held by a resource of another type. They need a person to decide. */
  conflicts: string[];
  /** Forms whose id sharing cannot hold, such as "my.form". They are not changed. Rename or recreate them by hand. */
  invalid: string[];
  /** Pass it back to go on. Absent when every form has been seen. */
  nextCursor?: string;
}

/**
 * Forms made before roles have no resource row and no owner. Nobody but the
 * deployment can reach them. This gives each of them one owner row for `owner`.
 * It is safe to run again: a form with a resource row is left as it is, and the
 * row and the grant are written in one transaction.
 *
 * One call handles one page of forms (`limit`, 25 by default) and returns
 * `nextCursor` while more remain. Call again with it until it is absent.
 */
export async function backfillOwners(store: Store, owner: string, options: { limit?: number; cursor?: string } = {}): Promise<BackfillResult> {
  if (typeof owner !== "string" || !SUBJECT_ID.test(owner)) throw new BackfillError("invalid_owner", 'give an owner of letters, digits, "-" and "_"');
  const limit = options.limit ?? BACKFILL_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > BACKFILL_PAGE) throw new BackfillError("invalid_query", `limit is a whole number from 1 to ${BACKFILL_PAGE}`);
  if (options.cursor !== undefined && (typeof options.cursor !== "string" || !wellFormedCursor(options.cursor))) throw new BackfillError("invalid_query", "the cursor is not valid");
  const sharing = createSharing(store);
  const ctx: PrincipalContext = { principalId: owner, kind: "human", chain: [{ id: owner, kind: "human" }], scopes: ["form:write"] };
  const page = await store.query("forms", { orderBy: { field: "id" }, limit, cursor: options.cursor });
  const result: BackfillResult = { created: [], skipped: 0, conflicts: [], invalid: [], ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
  for (const { id } of page.items) {
    if (!FORM_ID.test(id)) {
      result.invalid.push(id);
      continue;
    }
    try {
      await sharing.createResource(ctx, { id, type: "form" });
      result.created.push(id);
    } catch (error) {
      // The resource row is there already: made by a role, by another run, or by another app.
      if (!(error instanceof Error) || error.message !== "resource exists") throw error;
      if ((await store.get("resources", id))?.type === "form") result.skipped++;
      else result.conflicts.push(id);
    }
  }
  return result;
}
