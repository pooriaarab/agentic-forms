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
  constructor(readonly code: "invalid_input" | "erase_incomplete", message: string) {
    super(message);
    this.name = "FormsAccountError";
  }
}

export interface FormsAccount {
  id: "forms";
  /**
   * Collections: `forms` and `form_versions` (the forms the subject owns, head and frozen snapshots), `responses` (the answers
   * to those forms), `grants` (every role the subject holds on a form, with the form id), and `audit` (the entries whose root is
   * the subject). It holds no format, version, or time: the host's manifest has them. Answers hold no respondent id, so an answer
   * is exported only with the form it was sent to. The `madeBy` mark on a question is `human` or `agent` with no id: it travels with the form.
   */
  exportAccount(subject: Subject, deps: FormsAccountDeps): Promise<Record<FormsCollection, JsonRecord[]>>;
  /**
   * Erases each form that the subject is the only owner of, with its snapshots, answers, grants, and audit entries. A form with
   * another owner stays: only the subject's grant goes, as do the grants the subject holds on forms of others. Last, the audit
   * entries rooted in the subject go. Counts by the collection names. Run it with writes stopped. A repeat finds nothing and counts zero.
   * A failure names the form id: the repeat goes on from there, and the counts of the runs add up.
   * Invites and links record only the id of their maker, with no kind, so they are not matched to a subject: they leave with their form.
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

/** The subject's grants on forms. A grant on another kind of resource is another package's. */
async function formGrants(store: Store, subject: Subject) {
  const out: { id: string; resourceId: string; role: unknown; data: JsonRecord }[] = [];
  for await (const { id, data } of docs(store, "grants", { subjectId: subject.id })) {
    if (data.subjectKind !== subject.kind || typeof data.resourceId !== "string") continue;
    if ((await store.get("resources", data.resourceId))?.type !== "form") continue;
    out.push({ id, resourceId: data.resourceId, role: data.role, data: data as JsonRecord });
  }
  return out;
}

/** Audit entries whose root is the subject: a person, or an agent with its own identity, and what acts for them. */
async function auditOf(store: Store, subject: Subject) {
  const out: { id: string; data: JsonRecord }[] = [];
  for (const doc of await collect(store, "audit", { rootId: subject.id })) {
    const chain = doc.data.chain as { kind?: unknown }[] | undefined;
    const rootKind = chain?.[0]?.kind ?? doc.data.principalKind;
    const kind = rootKind === "human" || rootKind === "user_token" || rootKind === "agent_of_human" ? "human" : "agent";
    // A person and an agent with one id are two subjects. A delegated chain roots in its first step.
    if (kind === subject.kind) out.push(doc);
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
        if (grant.role === "owner" && owners.length === 1) {
          if ((await store.query("resources", { where: { parentId: formId }, limit: 1 })).items.length > 0) throw new Error("the form has child resources");
          const others = (await collect(store, "grants", { resourceId: formId })).length;
          const trail = (await collect(store, "audit", { resourceId: formId })).length;
          const snapshots = (await collect(store, "form_versions", { id: formId })).length;
          // The data goes first, so a stop leaves an owner who can run it again.
          const first = await ops.erase(formId);
          await sharing.deleteResource(ctx, formId);
          const second = await ops.erase(formId);
          counts.forms += 1;
          counts.form_versions += snapshots;
          counts.responses += first.erased + second.erased;
          counts.grants += others;
          counts.audit += trail;
        } else {
          await store.delete("grants", grant.id);
          counts.grants += 1;
        }
      } catch {
        throw new FormsAccountError("erase_incomplete", `erase stopped at form ${formId}: ${counts.forms} forms, ${counts.responses} responses, and ${counts.grants} grants were erased before it`);
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
