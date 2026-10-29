import { useEffect, useRef, useState } from "react";
import { Button, IconButton, Input, Tabs, useToast } from "agentic-design/react";
import type { Client } from "../src/client.js";
import type { Form, Question, Section } from "../src/core/form.js";
import { Preview } from "./Preview.js";
import { QuestionDialog, typeLabel } from "./QuestionDialog.js";
import { Responses } from "./Responses.js";
import { AgentMark, ErrorBox, Gate, None, canon, isConflict, setUnsaved, useLoad } from "./lib.js";

type Edit = { section: number; index: number | "new" };
const icon = (d: string) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const ICONS = { up: icon("M8 13V3M4 7l4-4 4 4"), down: icon("M8 3v10M4 9l4 4 4-4"), edit: icon("M3 13l1-3 7-7 2 2-7 7z"), remove: icon("M4 4l8 8M12 4l-8 8") };

function Editor({ api, initial, reload, origin }: { api: Client; initial: Form; reload: () => void; origin: string }) {
  const [form, setForm] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [sections, setSections] = useState<Section[]>(initial.sections);
  const [edit, setEdit] = useState<Edit | undefined>();
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState<"save" | "publish" | undefined>();
  const toast = useToast();
  const dirty = title !== form.title || canon(sections) !== canon(form.sections);
  useEffect(() => {
    setUnsaved(dirty);
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => {
      removeEventListener("beforeunload", warn);
      setUnsaved(false);
    };
  }, [dirty]);
  // A change moves or removes the control that had focus. This puts focus back on a control that is still there.
  const root = useRef<HTMLDivElement>(null);
  const [refocus, setRefocus] = useState<{ label: string } | undefined>();
  useEffect(() => {
    if (!refocus) return;
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const target = buttons.find((b) => b.getAttribute("aria-label") === refocus.label && !b.disabled) ?? buttons.find((b) => b.textContent?.startsWith("Add question"));
    target?.focus();
    setRefocus(undefined);
  }, [refocus, sections]);
  const closeDialog = (opener: HTMLElement | null) => {
    setEdit(undefined);
    // Radix has no trigger to give focus back to, so the opener gets it.
    requestAnimationFrame(() => (opener?.isConnected ? opener : root.current?.querySelector<HTMLButtonElement>("button[data-add]"))?.focus());
  };

  const flat = sections.flatMap((s) => s.questions);
  const patch = (si: number, questions: Question[]) => setSections((all) => all.map((s, i) => (i === si ? { ...s, questions } : s)));
  const move = (si: number, qi: number, by: -1 | 1) => {
    const list = [...sections[si]!.questions];
    const label = list[qi]!.label;
    [list[qi], list[qi + by]] = [list[qi + by]!, list[qi]!];
    patch(si, list);
    setRefocus({ label: `Move ${by === -1 ? "up" : "down"}: ${label}` });
  };
  // Save sends the whole draft. The server marks each new or changed question by who the caller is.
  const save = async (): Promise<Form | undefined> => {
    setBusy("save");
    setError(undefined);
    try {
      const saved = await api.updateForm(form.id, { title: title.trim(), sections, expectedRevision: form.revision ?? 0 });
      setForm(saved);
      setSections(saved.sections);
      setTitle(saved.title);
      return saved;
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  };
  const publish = async () => {
    const saved = dirty ? await save() : form;
    if (!saved) return;
    setBusy("publish");
    try {
      // The revision of what this page shows: a draft that changed elsewhere since is refused, not published unseen.
      setForm(await api.publishForm(form.id, { expectedRevision: saved.revision ?? 0 }));
      toast({ title: "Published", description: "The form is open to answers.", tone: "success" });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  };
  const link = `${origin}/f/${encodeURIComponent(form.id)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast({ title: "Link copied", tone: "success" });
    } catch {
      toast({ title: "Could not copy", description: "Select the link and copy it by hand.", tone: "warning" });
    }
  };
  const openDraft = form.status === "draft" && form.version > 1;
  const editing = edit && (edit.index === "new" ? undefined : sections[edit.section]!.questions[edit.index]);
  // A condition reads an earlier question: for a new one, any question up to the end of its section.
  const earlier = edit === undefined ? [] : edit.index === "new" ? sections.slice(0, edit.section + 1).flatMap((s) => s.questions) : flat.slice(0, flat.indexOf(editing!));

  const builder = (
    <div className="af-stack">
      <Input label="Form title" value={title} onChange={(e) => setTitle(e.target.value)} />
      {sections.map((s, si) => (
        <section key={s.id} className="af-stack" aria-labelledby={`sec-${si}`}>
          <h2 id={`sec-${si}`} style={{ margin: 0, fontSize: "var(--agd-font-size-lg)" }}>
            {s.title}
          </h2>
          {s.questions.length === 0 ? (
            <None title="No questions in this section" description="Add the first question." />
          ) : (
            <ol className="af-list" aria-label={`Questions in ${s.title}`}>
              {s.questions.map((q, qi) => (
                <li className="af-item" key={q.id}>
                  <div className="af-item__main">
                    <div className="af-item__label">{q.label}</div>
                    <div className="af-row">
                      <span className="af-tag">{typeLabel(q.type)}</span>
                      {q.required && <span className="af-tag">Required</span>}
                      {q.showIf && <span className="af-tag">Conditional</span>}
                      {q.madeBy === "agent" && <AgentMark what="changed this" />}
                    </div>
                  </div>
                  <div className="af-row">
                    <IconButton label={`Move up: ${q.label}`} icon={ICONS.up} size="sm" disabled={qi === 0} onClick={() => move(si, qi, -1)} />
                    <IconButton label={`Move down: ${q.label}`} icon={ICONS.down} size="sm" disabled={qi === s.questions.length - 1} onClick={() => move(si, qi, 1)} />
                    <IconButton label={`Edit: ${q.label}`} icon={ICONS.edit} size="sm" onClick={(e) => (setOpener(e.currentTarget), setEdit({ section: si, index: qi }))} />
                    <IconButton label={`Remove: ${q.label}`} icon={ICONS.remove} size="sm" variant="danger" onClick={() => (patch(si, s.questions.filter((_, i) => i !== qi)), setRefocus({ label: "" }))} />
                  </div>
                </li>
              ))}
            </ol>
          )}
          <div>
            <Button data-add="" onClick={(e) => (setOpener(e.currentTarget), setEdit({ section: si, index: "new" }))}>Add question{sections.length > 1 ? ` to ${s.title}` : ""}</Button>
          </div>
        </section>
      ))}
    </div>
  );

  return (
    <div className="af-stack" ref={root}>
      <div className="af-row af-row--between">
        <div>
          <h1 className="af-title">{form.title}</h1>
        </div>
        <div className="af-row">
          <span className="af-tag">{form.status === "published" ? "Published" : "Draft"}</span>
          <span className="af-muted">Version {form.version}</span>
          <Button onClick={save} loading={busy === "save"} disabled={!dirty}>
            Save
          </Button>
          <Button variant="primary" onClick={publish} loading={busy === "publish"} disabled={form.status === "published" && !dirty}>
            Publish
          </Button>
        </div>
      </div>
      <p role="status" className="af-muted" style={{ margin: 0 }}>
        {dirty ? "You have unsaved changes." : openDraft ? "Saved. This draft is not published: people still see version " + (form.version - 1) + "." : "All changes saved."}
      </p>
      {error !== undefined && <ErrorBox error={error} onRetry={isConflict(error) ? reload : undefined} retry={<Button onClick={reload}>Reload the form</Button>} />}
      {form.status === "published" || form.version > 1 ? (
        <div className="af-card af-row af-row--between">
          <div>
            <div className="af-item__label">Share link</div>
            <a className="af-link af-code" href={link} target="_blank" rel="noreferrer">
              {link}
            </a>
          </div>
          <Button onClick={copy}>Copy link</Button>
        </div>
      ) : (
        <p className="af-muted">Publish the form to get its share link.</p>
      )}
      <Tabs
        label="Form"
        value={tabValue()}
        onValueChange={(v) => (location.hash = `#/forms/${encodeURIComponent(form.id)}/${v}`)}
        tabs={[
          { value: "questions", label: "Questions", content: builder },
          { value: "preview", label: "Preview", content: <Preview form={{ ...form, title, sections }} /> },
          { value: "responses", label: "Responses", content: <Responses api={api} form={form} /> },
        ]}
      />
      {edit && (
        <QuestionDialog
          key={`${edit.section}-${edit.index}`}
          open
          question={editing}
          earlier={earlier}
          taken={flat.map((q) => q.id)}
          onOpenChange={(open) => !open && closeDialog(opener)}
          onSave={(q) => {
            const list = [...sections[edit.section]!.questions];
            if (edit.index === "new") list.push(q);
            else list[edit.index] = q;
            patch(edit.section, list);
            closeDialog(opener);
          }}
        />
      )}
    </div>
  );
}

const tabValue = () => /\/(preview|responses)$/.exec(location.hash)?.[1] ?? "questions";

/** `origin` is where the public fill link points: the Worker base URL, with no trailing slash. */
export function Builder({ api, formId, origin = location.origin }: { api: Client; formId: string; origin?: string }) {
  const [load, reload] = useLoad((signal) => api.getForm(formId, { signal }), formId);
  // The hash changes with the tab, so a re-render reads the current tab.
  return (
    <Gate load={load} what="the form" reload={reload}>
      {(form) => <Editor key={`${form.id}-${form.version}-${form.revision ?? 0}`} api={api} initial={form} reload={reload} origin={origin} />}
    </Gate>
  );
}
