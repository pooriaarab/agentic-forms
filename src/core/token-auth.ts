import type { Auth } from "agentic-identity";

const MIN_TOKEN_BYTES = 32;
/** A longer token would not fit the header pattern below, and every call would fail without a hint. */
const MAX_TOKEN_BYTES = 512;

/** Compares two secrets in constant time by comparing their digests. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return x.reduce((diff, byte, i) => diff | (byte ^ y[i]!), 0) === 0;
}

/**
 * One shared bearer token that stands for the deployment as a whole. It acts as
 * an agent with its own identity and all rights, so every form it makes belongs
 * to it. Use a store-backed Auth adapter to tell people apart. Throws on a token
 * shorter than 32 bytes. There is no default.
 */
export function createTokenAuth(token: string): Auth {
  const bytes = typeof token === "string" ? new TextEncoder().encode(token).length : 0;
  if (bytes < MIN_TOKEN_BYTES || bytes > MAX_TOKEN_BYTES) {
    throw new Error(`the API token must be a string of ${MIN_TOKEN_BYTES} to ${MAX_TOKEN_BYTES} bytes`);
  }
  return {
    async authenticate(request) {
      const given = /^Bearer (.{1,512})$/.exec(request.headers.get("authorization") ?? "")?.[1];
      if (given === undefined || !(await sameSecret(given, token))) return null;
      return { principalId: "deployment", kind: "agent", chain: [{ id: "deployment", kind: "agent" }], scopes: ["*:admin"] };
    },
  };
}

/** Tries each Auth in order. The first one that names a caller wins. */
export function firstAuth(...auths: Auth[]): Auth {
  return {
    async authenticate(request) {
      for (const auth of auths) {
        const ctx = await auth.authenticate(request.clone());
        if (ctx) return ctx;
      }
      return null;
    },
  };
}

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
