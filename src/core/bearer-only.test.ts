import type { Auth, PrincipalContext } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { bearerOnly } from "./bearer-only.js";

const ctx = (id: string): PrincipalContext => ({ principalId: id, kind: "human", chain: [{ id, kind: "human" }], scopes: ["*:admin"] });
const req = (headers: Record<string, string>) => new Request("https://x.test/api/v1/forms", { headers });

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
