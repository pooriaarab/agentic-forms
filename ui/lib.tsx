import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { EmptyState } from "agentic-design/react";
import { ApiError, createClient, type Client } from "../src/client.js";

const TOKEN_KEY = "agentic-forms-token";
// The token lives in this tab only. It is never written to disk.
export const getToken = () => sessionStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (token: string) => (token === "" ? sessionStorage.removeItem(TOKEN_KEY) : sessionStorage.setItem(TOKEN_KEY, token));
export const makeClient = (token: string): Client => createClient({ baseUrl: location.origin, token });

export type Load<T> = { state: "loading" } | { state: "error"; error: unknown } | { state: "ready"; data: T };

/** Runs `work` on mount and when `key` changes. `reload` runs it again. */
export function useLoad<T>(work: (signal: AbortSignal) => Promise<T>, key: string): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const latest = useRef(work);
  latest.current = work;
  useEffect(() => {
    const abort = new AbortController();
    setLoad({ state: "loading" });
    latest.current(abort.signal).then(
      (data) => !abort.signal.aborted && setLoad({ state: "ready", data }),
      (error: unknown) => !abort.signal.aborted && setLoad({ state: "error", error }),
    );
    return () => abort.abort();
  }, [key, tick]);
  return [load, useCallback(() => setTick((n) => n + 1), [])];
}

/** One sentence for a refused call, plus the faults the API listed. */
export function explain(error: unknown): { message: string; issues: string[] } {
  if (error instanceof ApiError) {
    const issues = (error.issues ?? []).map((i) => {
      const r = i as { message?: string; question?: string; path?: string };
      return [r.question ?? r.path, r.message].filter(Boolean).join(": ");
    });
    const message =
      error.status === 401 ? "The token was not accepted. Sign in again."
      : error.status === 403 ? "Your role does not allow this."
      : error.status === 404 ? "This form was not found, or you have no role on it."
      : error.code === "version_conflict" ? "Someone changed this form since you opened it. Reload it, then make your change again."
      : error.message;
    return { message, issues };
  }
  return { message: error instanceof Error ? error.message : "Something went wrong.", issues: [] };
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="af-loading" role="status">
      <span className="agd-spinner" aria-hidden="true" /> Loading {what}…
    </p>
  );
}

export function ErrorBox({ error, onRetry, retry }: { error: unknown; onRetry?: () => void; retry?: ReactNode }) {
  const { message, issues } = explain(error);
  return (
    <div className="af-alert" role="alert">
      <strong>Error.</strong> {message}
      {issues.length > 0 && (
        <ul>
          {issues.map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
      )}
      {onRetry && <div style={{ marginTop: "0.5rem" }}>{retry}</div>}
    </div>
  );
}

export function Gate<T>({ load, what, reload, children, empty }: { load: Load<T>; what: string; reload: () => void; children: (data: T) => ReactNode; empty?: (data: T) => ReactNode | null }) {
  if (load.state === "loading") return <Loading what={what} />;
  if (load.state === "error") return <ErrorBox error={load.error} onRetry={reload} retry={<button className="agd-button" onClick={reload}>Try again</button>} />;
  return <>{empty?.(load.data) ?? children(load.data)}</>;
}

export const None = ({ title, description, action }: { title: string; description?: string; action?: ReactNode }) => <EmptyState title={title} description={description} action={action} />;

export function AgentMark({ what }: { what: string }) {
  return (
    <span className="af-agent">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="3" y="5" width="10" height="8" rx="2" />
        <path d="M8 5V2.5M6 9h.01M10 9h.01" />
      </svg>
      Agent {what}
    </span>
  );
}

/** JSON with sorted keys, so two questions with the same fields compare equal. */
export const canon = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

// The open builder says whether it holds unsaved edits, so a move to another page can ask first.
let unsaved = false;
export const setUnsaved = (value: boolean) => (unsaved = value);
export const confirmLeave = () => !unsaved || confirm("You have unsaved changes. Leave and lose them?");
export const isConflict = (error: unknown) => error instanceof ApiError && error.code === "version_conflict";
