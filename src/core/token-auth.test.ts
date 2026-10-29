import type { Auth, PrincipalContext } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { bearerOnly, createTokenAuth, firstAuth } from "./token-auth.js";

const ctx = (id: string): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes: ["*:admin"] });
const named = (id: string, accepts: string): Auth => ({ authenticate: async (r) => (r.headers.get("authorization") === `Bearer ${accepts}` ? ctx(id) : null) });
const req = (headers: Record<string, string>) => new Request("https://x.test/api/v1/forms", { headers });

describe("firstAuth", () => {
  test("the first Auth that names a caller wins, and one that says no falls through", async () => {
    const auth = firstAuth(named("a", "one"), named("b", "two"));
    expect((await auth.authenticate(req({ authorization: "Bearer one" })))?.principalId).toBe("a");
    expect((await auth.authenticate(req({ authorization: "Bearer two" })))?.principalId).toBe("b");
    expect(await auth.authenticate(req({ authorization: "Bearer three" }))).toBeNull();
    expect(await auth.authenticate(req({}))).toBeNull();
  });

  test("the shared token and a stored credential both work in one chain", async () => {
    const token = "t".repeat(40);
    const auth = firstAuth(createTokenAuth(token), named("stored", "aid_x"));
    expect((await auth.authenticate(req({ authorization: `Bearer ${token}` })))?.principalId).toBe("deployment");
    expect((await auth.authenticate(req({ authorization: "Bearer aid_x" })))?.principalId).toBe("stored");
  });
});

describe("bearerOnly", () => {
  test("a cookie alone gives nothing, and a cookie is not passed on", async () => {
    let seen: string | null = "unset";
    const cookieAware: Auth = { authenticate: async (r) => ((seen = r.headers.get("cookie")), r.headers.has("cookie") ? ctx("by-cookie") : ctx("by-bearer")) };
    const auth = bearerOnly(cookieAware);
    expect(await auth.authenticate(req({ cookie: "session=aid_x" }))).toBeNull();
    expect((await auth.authenticate(req({ authorization: "Bearer aid_x", cookie: "session=aid_y" })))?.principalId).toBe("by-bearer");
    expect(seen).toBeNull();
  });
});

describe("createTokenAuth", () => {
  test("a token with a character the Bearer header check refuses is refused at start", () => {
    expect(() => createTokenAuth("a+b/".repeat(10) + "==")).toThrow("API token");
    expect(() => createTokenAuth("a-b_".repeat(10))).not.toThrow();
  });
});
