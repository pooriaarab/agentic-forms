// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type MountedForms } from "./embed.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no matchMedia, and the theme provider asks for it.
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const summary = (id: string, title: string) => ({ id, title, status: "draft", version: 1 });

let host: HTMLElement;
let mounted: MountedForms | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  location.hash = "";
  fetchMock = vi.fn(async (url: string) => (url.endsWith("/api/v1/forms") ? json({ forms: [summary("a", "Alpha")] }) : json({ error: "not_found" }, 404)));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const base = { baseUrl: "https://forms.example.com", getToken: () => "tok-1" };

describe("mount", () => {
  it.each([
    ["no options", undefined],
    ["no getToken", { baseUrl: base.baseUrl }],
    ["a token string instead of a callback", { baseUrl: base.baseUrl, getToken: "tok" }],
    ["no baseUrl", { getToken: base.getToken }],
    ["a relative baseUrl", { baseUrl: "/api", getToken: base.getToken }],
    ["user info in baseUrl", { baseUrl: "https://u:p@forms.example.com", getToken: base.getToken }],
  ])("throws a TypeError for %s and renders nothing", (_label, options) => {
    expect(() => mount(host, options as never)).toThrow(TypeError);
    expect(host.innerHTML).toBe("");
  });

  it("lists the forms of the token and sends the callback token on each call", async () => {
    const getToken = vi.fn(async () => "fresh-token");
    await act(async () => void (mounted = mount(host, { ...base, getToken })));
    await settle();
    expect(host.textContent).toContain("Alpha");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://forms.example.com/api/v1/forms");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer fresh-token" });
    expect(getToken).toHaveBeenCalled();
  });

  it("shows a refused call as an alert, not as success", async () => {
    fetchMock.mockImplementation(async () => json({ error: "unauthorized" }, 401));
    await act(async () => void (mounted = mount(host, base)));
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The token was not accepted");
    expect(host.textContent).not.toContain("Alpha");
  });

  it("shows an alert when the callback returns an empty token, and sends no request", async () => {
    await act(async () => void (mounted = mount(host, { ...base, getToken: () => "" })));
    await settle();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("update points the UI at another Worker, and a bad update keeps the UI", async () => {
    await act(async () => void (mounted = mount(host, base)));
    await settle();
    expect(() => mounted!.update({ baseUrl: "nope", getToken: base.getToken })).toThrow(TypeError);
    expect(host.textContent).toContain("Alpha");
    await act(async () => mounted!.update({ baseUrl: "https://other.example.com", getToken: () => "tok-2" }));
    await settle();
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("https://other.example.com/api/v1/forms");
  });

  it("unmount removes the UI", async () => {
    await act(async () => void (mounted = mount(host, base)));
    await settle();
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(host.innerHTML).toBe("");
  });
});
