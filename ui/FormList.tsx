import { useState, type FormEvent } from "react";
import { Button, Dialog, Input } from "agentic-design/react";
import type { Client } from "../src/client.js";
import { ErrorBox, Gate, None, useLoad } from "./lib.js";

const SLUG = /^[A-Za-z0-9_-]{1,100}$/;
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

function NewForm({ api, onDone }: { api: Client; onDone: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [id, setId] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const shownId = touched ? id : slug(title);
  const idBad = shownId !== "" && !SLUG.test(shownId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.createForm({ id: shownId, title: title.trim(), sections: [{ id: "main", title: "Questions", questions: [] }] });
      setOpen(false);
      onDone(shownId);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button variant="primary">New form</Button>}
      title="New form"
      description="A draft form with one section. Add questions next."
    >
      <form className="af-stack" onSubmit={submit}>
        <Input label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} />
        <Input
          label="Form id"
          hint="Letters, digits, - and _. It is part of the share link."
          required
          value={shownId}
          error={idBad ? "Use only letters, digits, - and _." : undefined}
          onChange={(e) => (setTouched(true), setId(e.target.value))}
        />
        {error !== undefined && <ErrorBox error={error} />}
        <div className="af-row">
          <Button type="submit" variant="primary" loading={busy} disabled={title.trim() === "" || shownId === "" || idBad}>
            Create form
          </Button>
          <Button type="button" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function FormList({ api }: { api: Client }) {
  const [load, reload] = useLoad((signal) => api.listForms({ signal }), "forms");
  const open = (id: string) => (location.hash = `#/forms/${encodeURIComponent(id)}`);
  return (
    <div className="af-stack">
      <div className="af-row af-row--between">
        <h1 className="af-title">Your forms</h1>
        <NewForm api={api} onDone={open} />
      </div>
      <Gate
        load={load}
        what="forms"
        reload={reload}
        empty={(forms) => (forms.length === 0 ? <None title="No forms yet" description="Make your first form. An agent can make one too: use the CLI, MCP, or API." /> : null)}
      >
        {(forms) => (
          <ul className="af-list" aria-label="Forms">
            {forms.map((f) => (
              <li className="af-item" key={f.id}>
                <div className="af-item__main">
                  <a className="af-link af-item__label" href={`#/forms/${encodeURIComponent(f.id)}`}>
                    {f.title}
                  </a>
                  <div className="af-muted af-code">{f.id}</div>
                </div>
                <span className="af-tag">{f.status === "published" ? "Published" : "Draft"}</span>
                <span className="af-muted">Version {f.version}</span>
              </li>
            ))}
          </ul>
        )}
      </Gate>
    </div>
  );
}
