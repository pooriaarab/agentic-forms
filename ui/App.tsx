import { useEffect, useState, type FormEvent } from "react";
import { AppShell, Button, Input, Select, SidebarNav, useTheme } from "agentic-design/react";
import { ApiError } from "../src/client.js";
import { Builder } from "./Builder.js";
import { FormList } from "./FormList.js";
import { ErrorBox, confirmLeave, getToken, makeClient, setToken } from "./lib.js";

const formOf = (hash: string) => /^#\/forms\/([^/]+)/.exec(hash)?.[1];

const useHash = () => {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    let undoing = false;
    const on = (e: HashChangeEvent) => {
      // The event of our own step back is not a move.
      if (undoing) return void (undoing = false);
      const from = new URL(e.oldURL).hash;
      // Moving to another page with unsaved edits asks first. Moving between the tabs of one form does not.
      if (formOf(from) !== formOf(location.hash) && !confirmLeave()) {
        undoing = true;
        location.hash = from;
        return;
      }
      setHash(location.hash);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
};

function SignIn({ onToken }: { onToken: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await makeClient(value.trim()).listForms(); // proves the token before it is kept
      onToken(value.trim());
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e : new Error("Sign-in failed."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="af-signin af-stack" id="main">
      <h1 className="af-title">Forms</h1>
      <p className="af-muted">Sign in with an API token for this Worker. The token stays in this tab until you sign out.</p>
      <form className="af-stack" onSubmit={submit}>
        <Input label="API token" type="password" autoComplete="off" required value={value} onChange={(e) => setValue(e.target.value)} />
        {error !== undefined && <ErrorBox error={error} />}
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={value.trim() === ""}>
            Sign in
          </Button>
        </div>
      </form>
    </main>
  );
}

export function App() {
  const [token, setTok] = useState(getToken());
  const hash = useHash();
  const { preference, setPreference } = useTheme();
  if (token === "") {
    return <SignIn onToken={(t) => (setToken(t), setTok(t))} />;
  }
  const api = makeClient(token);
  const match = /^#\/forms\/([^/]+)(?:\/(questions|preview|responses))?$/.exec(hash);
  const formId = match ? decodeURIComponent(match[1]!) : undefined;
  return (
    <AppShell
      brand="Forms"
      sidebar={<SidebarNav label="Main" items={[{ href: "#/", label: "All forms", current: formId === undefined }]} />}
      topbar={
        <>
          <Select
            label="Theme"
            hideLabel
            value={preference}
            onChange={(e) => setPreference(e.target.value as "light" | "dark" | "system")}
          >
            <option value="system">Theme: system</option>
            <option value="light">Theme: light</option>
            <option value="dark">Theme: dark</option>
          </Select>
          <Button size="sm" onClick={() => confirmLeave() && (setToken(""), setTok(""))}>
            Sign out
          </Button>
        </>
      }
    >
      <div className="af-page">
        {formId === undefined ? <FormList api={api} /> : <Builder key={formId} api={api} formId={formId} />}
      </div>
    </AppShell>
  );
}
