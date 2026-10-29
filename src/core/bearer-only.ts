import type { Auth } from "agentic-identity";

/** Reads the bearer header only. A cookie is ambient: a page on another site can make the browser send it. */
export function bearerOnly(auth: Auth): Auth {
  return {
    async authenticate(request) {
      if (!request.headers.get("authorization")) return null;
      const headers = new Headers(request.headers);
      headers.delete("cookie");
      return auth.authenticate(new Request(request.url, { method: request.method, headers }));
    },
  };
}
