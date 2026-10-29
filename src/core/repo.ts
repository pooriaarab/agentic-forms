import { validateForPublish, validateForm, type Form, type Issue } from "./form.js";
import type { Doc, Store } from "agentic-identity";

const HEADS = "forms";
const VERSIONS = "form_versions";

export class FormError extends Error {
  constructor(readonly issues: Issue[]) {
    super(`the form has ${issues.length} fault${issues.length === 1 ? "" : "s"}: ${issues.map((i) => i.message).join("; ")}`);
    this.name = "FormError";
  }
}

/** The head moved since the caller read it. Read again and retry. */
export class VersionConflictError extends Error {
  constructor(readonly formId: string, readonly expected: number, readonly actual: number | null, message?: string) {
    super(message ?? `form "${formId}" is at version ${actual ?? "none"}, not ${expected}`);
    this.name = "VersionConflictError";
  }
}

/** A published version is frozen. It is never written twice. */
export class SnapshotExistsError extends Error {
  constructor(readonly formId: string, readonly version: number) {
    super(`version ${version} of form "${formId}" is already published and cannot change`);
    this.name = "SnapshotExistsError";
  }
}

const asDoc = (form: Form) => form as unknown as Doc;

/**
 * Forms keep a head (the latest version, draft or published) and one frozen
 * snapshot per published version. Responses point at a snapshot, so an edit
 * never changes what an old response means.
 */
export function createFormRepo(store: Store) {
  const get = async (id: string) => (await store.get(HEADS, id)) as unknown as Form | null;
  const getVersion = async (id: string, version: number) =>
    (await store.get(VERSIONS, `${id}@${version}`)) as unknown as Form | null;

  return {
    get,
    getVersion,
    /** Deletes the head first, so no new answer lands, then every frozen snapshot. Safe to run again. */
    async erase(id: string): Promise<void> {
      await store.delete(HEADS, id);
      for (;;) {
        const page = await store.query(VERSIONS, { where: { id }, limit: 100 });
        if (page.items.length === 0) return;
        for (const entry of page.items) await store.delete(VERSIONS, entry.id);
      }
    },
    /**
     * Stores a draft. Editing a published form starts the next version. Throws
     * FormError on unsound logic. With `expectedVersion`, the save is a
     * compare-and-set: it throws VersionConflictError unless the head is still
     * at that version.
     */
    async save(form: Form, options: { expectedVersion?: number; expectedRevision?: number } = {}): Promise<Form> {
      const issues = validateForm(form);
      if (issues.length > 0) throw new FormError(issues);
      return store.transaction(async (tx) => {
        const head = (await tx.get(HEADS, form.id)) as unknown as Form | null;
        const { expectedVersion } = options;
        if (expectedVersion !== undefined && head?.version !== expectedVersion) {
          throw new VersionConflictError(form.id, expectedVersion, head?.version ?? null);
        }
        const { expectedRevision } = options;
        if (expectedRevision !== undefined && (head?.revision ?? 0) !== expectedRevision) {
          throw new VersionConflictError(form.id, head?.version ?? 0, head?.version ?? null, `form "${form.id}" changed since revision ${expectedRevision}: read it again`);
        }
        const version = head ? (head.status === "published" ? head.version + 1 : head.version) : 1;
        const draft: Form = { ...form, version, status: "draft", revision: (head?.revision ?? 0) + 1 };
        await tx.put(HEADS, form.id, asDoc(draft));
        return draft;
      });
    },
    /** Freezes the head as a new published version. Throws SnapshotExistsError rather than replace one. */
    async publish(id: string): Promise<Form> {
      return store.transaction(async (tx) => {
        const head = (await tx.get(HEADS, id)) as unknown as Form | null;
        if (!head) throw new Error(`form "${id}" not found`);
        if (head.status === "published") throw new Error(`form "${id}" is already published`);
        const issues = validateForPublish(head);
        if (issues.length > 0) throw new FormError(issues);
        if ((await tx.get(VERSIONS, `${id}@${head.version}`)) !== null) throw new SnapshotExistsError(id, head.version);
        const published: Form = { ...head, status: "published", revision: (head.revision ?? 0) + 1 };
        await tx.put(HEADS, id, asDoc(published));
        await tx.put(VERSIONS, `${id}@${head.version}`, asDoc(published));
        return published;
      });
    },
    /** The version that takes answers now: the newest published snapshot. */
    async getPublished(id: string): Promise<Form | null> {
      const head = await get(id);
      if (!head) return null;
      const version = head.status === "published" ? head.version : head.version - 1;
      return version < 1 ? null : getVersion(id, version);
    },
    async list(): Promise<Form[]> {
      const forms: Form[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.query(HEADS, { orderBy: { field: "id" }, cursor });
        forms.push(...page.items.map((entry) => entry.data as unknown as Form));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return forms;
    },
  };
}

export type FormRepo = ReturnType<typeof createFormRepo>;
