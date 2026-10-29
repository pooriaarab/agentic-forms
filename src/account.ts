// The package's side of the account contract: a host calls `exportAccount` and `eraseAccount`
// and never reads the storage layout. The shape is provisional: it is the contract that a later
// `agentic-identity` release adds to `agentic-identity/account` as `AccountPackage`. The `AccountApp` of earlier releases is a different contract, and this does not fit it.
import { MAX_OWNERS_ON_ERASE, SUBJECT_KINDS, createSharing, type PrincipalContext, type Store, type Subject } from "agentic-identity";
import { createOps } from "./ops.js";

export interface FormsAccountDeps {
  store: Store;
}

type JsonRecord = Record<string, unknown>;
export type FormsCollection = "forms" | "form_versions" | "responses" | "grants" | "audit";

/** Refused input, or an erase that stopped. A message names a form id, never answers or people. */
export class FormsAccountError extends Error {
  constructor(readonly code: "invalid_input" | "erase_incomplete", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FormsAccountError";
  }
}

export interface FormsAccount {
  id: "forms";
  /**
   * Collections: `forms` and `form_versions` (the forms the subject owns, head and frozen snapshots), `responses` (the answers
   * to those forms), `grants` (every role the subject holds on a form, with the form id), and `audit` (the entries on forms whose root is
   * the subject). It holds no format, version, or time: the host's manifest has them. Answers hold no respondent id, so an answer
   * is exported only with the form it was sent to. The `madeBy` mark on a question is `human` or `agent` with no id: it travels with the form.
   */
  exportAccount(subject: Subject, deps: FormsAccountDeps): Promise<Record<FormsCollection, JsonRecord[]>>;
  /**
   * Erases each form that the subject is the only owner of, with its snapshots, answers, grants, and audit entries. A form with
   * another owner stays: only the subject's grant goes, as do the grants the subject holds on forms of others. Last, the audit
   * entries rooted in the subject go. Counts by the collection names. Run it with writes stopped. A repeat finds nothing and counts zero.
   * A failure names the form id. A stop before the resource row goes is finished by a repeat, and the counts of the runs add up. A stop after it leaves nothing to find, and the counts of forms, grants, and audit entries for that form may be missing from the error message. Entries on a resource that is already gone are not matched and stay.
   * A grant with no valid kind stops both calls: run `migrateGrants` first. An audit entry with no known root kind, or on a resource that is not a form, is left alone. Invites and links record only the id of their maker, with no kind, so they are not matched to a subject: they leave with their form.
   */
  eraseAccount(subject: Subject, deps: FormsAccountDeps): Promise<Record<FormsCollection, number>>;
}

// Through JSON, so the records are what a file would hold: a key with no value is dropped, not left as `undefined`.
const plain = (value: unknown): JsonRecord[] => JSON.parse(JSON.stringify(value)) as JsonRecord[];

function check(subject: Subject, deps: FormsAccountDeps): Store {
  if (typeof deps?.store?.query !== "function" || typeof deps.store.delete !== "function") throw new FormsAccountError("invalid_input", "formsAccount needs deps.store");
  if (typeof subject?.id !== "string" || subject.id.trim() === "" || !(SUBJECT_KINDS as readonly unknown[]).includes(subject.kind)) {
    throw new FormsAccountError("invalid_input", "subject needs an id and a kind of human or agent");
  }
  return deps.store;
}

async function* docs(store: Store, collection: string, where: Record<string, string>) {
  let cursor: string | undefined;
  do {
    const page = await store.query(collection, { where, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    yield* page.items;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

const collect = async (store: Store, collection: string, where: Record<string, string>) => {
  const out: { id: string; data: JsonRecord }[] = [];
  for await (const doc of docs(store, collection, where)) out.push(doc as { id: string; data: JsonRecord });
  return out;
};

/**
 * The subject's grants on forms. A grant on another kind of resource is another package's. A grant with no valid kind
 * could be the person's or the agent's, so it stops the call: run `migrateGrants` first.
 */
async function formGrants(store: Store, subject: Subject) {
  const out: { id: string; resourceId: string; role: unknown; data: JsonRecord }[] = [];
  for await (const { id, data } of docs(store, "grants", { subjectId: subject.id })) {
    if (!(SUBJECT_KINDS as readonly unknown[]).includes(data.subjectKind)) throw new FormsAccountError("invalid_input", `a grant has no valid kind: run migrateGrants first (grant ${id})`);
    if (data.subjectKind !== subject.kind || typeof data.resourceId !== "string") continue;
    if ((await store.get("resources", data.resourceId))?.type !== "form") continue;
    out.push({ id, resourceId: data.resourceId, role: data.role, data: data as JsonRecord });
  }
  return out;
}

/**
 * Audit entries on forms whose root is the subject: a person, or an agent with its own identity, and what acts for them.
 * An entry with no known root kind, no resource, or a resource that is not a form is not matched: it is not provably the subject's here.
 */
async function auditOf(store: Store, subject: Subject) {
  const out: { id: string; data: JsonRecord }[] = [];
  const isForm = new Map<string, boolean>();
  for (const doc of await collect(store, "audit", { rootId: subject.id })) {
    const chain = doc.data.chain;
    const root = Array.isArray(chain) ? (chain[0] as { kind?: unknown } | undefined) : undefined;
    // A person and an agent with one id are two subjects. A delegated chain roots in its first step.
    if (root?.kind !== subject.kind) continue;
    const resourceId = doc.data.resourceId;
    if (typeof resourceId !== "string") continue;
    if (!isForm.has(resourceId)) isForm.set(resourceId, (await store.get("resources", resourceId))?.type === "form");
    if (isForm.get(resourceId)) out.push(doc);
  }
  return out;
}

export const formsAccount: FormsAccount = {
  id: "forms",
  async exportAccount(subject, deps) {
    const store = check(subject, deps);
    const grants = await formGrants(store, subject);
    const owned = grants.filter((g) => g.role === "owner").map((g) => g.resourceId);
    const forms: JsonRecord[] = [];
    const versions: JsonRecord[] = [];
    const responses: JsonRecord[] = [];
    for (const formId of owned) {
      const head = await store.get("forms", formId);
      if (head !== null) forms.push(head as JsonRecord);
      versions.push(...(await collect(store, "form_versions", { id: formId })).map((d) => d.data));
      responses.push(...(await collect(store, "responses", { formId })).map((d) => d.data));
    }
    return {
      forms: plain(forms),
      form_versions: plain(versions),
      responses: plain(responses),
      grants: plain(grants.map((g) => g.data)),
      audit: plain((await auditOf(store, subject)).map((d) => d.data)),
    };
  },
  async eraseAccount(subject, deps) {
    const store = check(subject, deps);
    const counts: Record<FormsCollection, number> = { forms: 0, form_versions: 0, responses: 0, grants: 0, audit: 0 };
    const ctx: PrincipalContext = { principalId: subject.id, kind: subject.kind, chain: [{ id: subject.id, kind: subject.kind }], scopes: ["form:admin"] };
    const sharing = createSharing(store);
    const ops = createOps(store);
    for (const grant of await formGrants(store, subject)) {
      const formId = grant.resourceId;
      try {
        const owners = (await store.query("grants", { where: { resourceId: formId, role: "owner" }, limit: MAX_OWNERS_ON_ERASE + 1 })).items;
        // An owner with no valid kind cannot be told from the subject: keep the form rather than guess.
        if (owners.some((o) => !(SUBJECT_KINDS as readonly unknown[]).includes(o.data.subjectKind))) throw new Error("an owner grant has no valid kind");
        if (grant.role === "owner" && owners.length === 1) {
          if ((await store.query("resources", { where: { parentId: formId }, limit: 1 })).items.length > 0) throw new Error("the form has child resources");
          const others = (await collect(store, "grants", { resourceId: formId })).length;
          const trail = (await collect(store, "audit", { resourceId: formId })).length;
          const snapshots = (await collect(store, "form_versions", { id: formId })).length;
          // The data goes first, so a stop leaves an owner who can run it again. Each count is added when its step is done.
          const first = await ops.erase(formId);
          counts.form_versions += snapshots;
          counts.responses += first.erased;
          await sharing.deleteResource(ctx, formId);
          counts.forms += 1;
          counts.grants += others;
          counts.audit += trail;
          counts.responses += (await ops.erase(formId)).erased;
        } else {
          await store.delete("grants", grant.id);
          counts.grants += 1;
        }
      } catch (cause) {
        throw new FormsAccountError("erase_incomplete", `erase stopped at form ${formId}: ${counts.forms} forms, ${counts.form_versions} snapshots, ${counts.responses} responses, ${counts.grants} grants, and ${counts.audit} audit entries were erased before it`, { cause });
      }
    }
    // Last: the steps above write audit entries for the subject.
    for (const { id } of await auditOf(store, subject)) {
      await store.delete("audit", id);
      counts.audit += 1;
    }
    return counts;
  },
};
