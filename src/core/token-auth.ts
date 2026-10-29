import type { Auth } from "agentic-identity";

const MIN_TOKEN_BYTES = 32;

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
  if (typeof token !== "string" || new TextEncoder().encode(token).length < MIN_TOKEN_BYTES) {
    throw new Error(`the API token must be a string of at least ${MIN_TOKEN_BYTES} bytes`);
  }
  return {
    async authenticate(request) {
      const given = /^Bearer (.{1,512})$/.exec(request.headers.get("authorization") ?? "")?.[1];
      if (given === undefined || !(await sameSecret(given, token))) return null;
      return { principalId: "deployment", kind: "agent", chain: [{ id: "deployment", kind: "agent" }], scopes: ["*:admin"] };
    },
  };
}
