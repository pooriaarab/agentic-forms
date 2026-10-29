import { useState } from "react";
import { Button, useToast } from "agentic-design/react";
import type { Client, Page } from "../src/client.js";
import type { Form } from "../src/core/form.js";
import type { Response } from "../src/core/responses.js";
import { ErrorBox, Gate, None, explain, useLoad } from "./lib.js";

const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === undefined ? "" : String(v));

export function Responses({ api, form }: { api: Client; form: Form }) {
  const [more, setMore] = useState<Response[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [busy, setBusy] = useState<"more" | "csv" | undefined>();
  const [error, setError] = useState<unknown>();
  const toast = useToast();
  const [load, reload] = useLoad(async (signal): Promise<Page<Response>> => {
    const page = await api.listResponses(form.id, { limit: 100 }, { signal });
    setMore([]);
    setCursor(page.nextCursor);
    return page;
  }, form.id);
  const columns = form.sections.flatMap((s) => s.questions).filter((q) => q.type !== "file");

  const next = async () => {
    setBusy("more");
    try {
      const page = await api.listResponses(form.id, { limit: 100, cursor });
      setMore((m) => [...m, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  };
  const download = async () => {
    setBusy("csv");
    try {
      const blob = new Blob([await api.exportCsv(form.id)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: `${form.id}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast({ title: "CSV exported", description: `${form.id}.csv`, tone: "success" });
    } catch (e) {
      toast({ title: "Export failed", description: explain(e).message, tone: "danger" });
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Gate load={load} what="responses" reload={reload} empty={(p) => (p.items.length === 0 ? <None title="No responses yet" description={form.status === "published" ? "Share the link. Answers show here." : "Publish the form to open it to answers."} /> : null)}>
      {(page) => {
        const rows = [...page.items, ...more];
        return (
          <div className="af-stack">
            <div className="af-row af-row--between">
              <p className="af-muted" role="status">
                {rows.length} {rows.length === 1 ? "response" : "responses"} shown
              </p>
              <Button onClick={download} loading={busy === "csv"}>
                Export CSV
              </Button>
            </div>
            <div className="af-table-wrap" tabIndex={0} role="region" aria-label="Responses table">
              <table className="af-table">
                <caption>Responses, oldest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Submitted</th>
                    <th scope="col">Version</th>
                    {columns.map((q) => (
                      <th scope="col" key={q.id}>
                        {q.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.submittedAt).toLocaleString()}</td>
                      <td>{r.formVersion}</td>
                      {columns.map((q) => (
                        <td key={q.id}>{show(r.values[q.id])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error !== undefined && <ErrorBox error={error} />}
            {cursor !== undefined && (
              <div>
                <Button onClick={next} loading={busy === "more"}>
                  Load more
                </Button>
              </div>
            )}
          </div>
        );
      }}
    </Gate>
  );
}
