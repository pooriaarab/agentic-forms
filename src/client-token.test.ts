import { describe, expect, test } from "vitest";
import { createClient } from "./client.js";

const seen: string[] = [];
const fetchOk = (async (_url: unknown, init?: RequestInit) => {
  seen.push((init?.headers as Record<string, string>).authorization ?? "");
  return new Response(JSON.stringify({ forms: [] }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

describe("a token function", () => {
  test("is called before each request, so a refreshed token is used", async () => {
    let n = 0;
    const client = createClient({ baseUrl: "https://f.example.com", token: async () => `t${++n}`, fetch: fetchOk });
    await client.listForms();
    await client.listForms();
    expect(seen).toEqual(["Bearer t1", "Bearer t2"]);
  });

  test("an empty or non-string result is a TypeError and sends nothing", async () => {
    seen.length = 0;
    for (const bad of ["", undefined]) {
      const client = createClient({ baseUrl: "https://f.example.com", token: (() => bad) as never, fetch: fetchOk });
      await expect(client.listForms()).rejects.toThrow(TypeError);
    }
    expect(seen).toEqual([]);
  });

  test("a token that is neither a string nor a function is refused", () => {
    expect(() => createClient({ baseUrl: "https://f.example.com", token: 5 as never })).toThrow(TypeError);
  });
});
