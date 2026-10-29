// The forms UI for an app that embeds it: `agentic-forms/ui`. The app gives a Worker base URL and a token callback.
// The web UI that the Worker serves renders the same pages. React and react-dom are peer dependencies.
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastProvider, TooltipProvider } from "agentic-design/react";
import "./app.css";
import { createClient } from "../src/client.js";
import { Pages, useHash } from "./App.js";

export interface FormsUiOptions {
  /** The Worker origin as an absolute URL, for example "https://forms.example.com". The share link of a form points here. */
  baseUrl: string;
  /** Called before each request. Return the bearer token of the signed-in person or agent. The server checks every call against it. */
  getToken: () => string | Promise<string>;
}

function check(options: FormsUiOptions): void {
  if (!options || typeof options.getToken !== "function") throw new TypeError("the forms UI needs a getToken function");
  // createClient refuses a bad baseUrl with a TypeError.
  createClient({ baseUrl: options.baseUrl, token: options.getToken });
}

/** The forms pages. They need the theme, tooltip, and toast providers above them. `mount` adds them. The pages read the address hash (`#/forms/<id>`). */
export function FormsUi({ baseUrl, getToken }: FormsUiOptions) {
  const api = useMemo(() => createClient({ baseUrl, token: getToken }), [baseUrl, getToken]);
  const hash = useHash();
  return <Pages api={api} hash={hash} origin={new URL(baseUrl).origin} />;
}

export interface MountedForms {
  /** Point the UI at another Worker or token callback. A bad option throws and keeps the UI as it is. */
  update(options: FormsUiOptions): void;
  /** Remove the UI. */
  unmount(): void;
}

/** Render the forms UI into an element, for an app that does not use React itself. */
export function mount(element: HTMLElement, options: FormsUiOptions): MountedForms {
  check(options);
  const root = createRoot(element);
  const render = (next: FormsUiOptions) =>
    root.render(
      <StrictMode>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <FormsUi key={next.baseUrl} {...next} />
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </StrictMode>,
    );
  render(options);
  return { update: (next) => (check(next), render(next)), unmount: () => root.unmount() };
}
