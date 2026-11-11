import { operationFetch } from "./streams.js";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { VortexifyProvider, useVortexify } from "../src/provider.js";
import { VortexifyClient } from "../src/client.js";
import type { VortexifyContextValue } from "../src/provider.js";

const config = { orgId: "org", baseUrl: "https://server.example", projectId: "project" };
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.restoreAllMocks());

it("rejects remote proxy destinations and invalid local prefixes", async () => {
  const fetchMock = operationFetch();
  const remote = new VortexifyClient({ ...config, development: true, endpoints: { runApi: "https://other.example/run" } }, () => null, undefined, "dev-proxy");
  await expect(remote.runApi("sales")).rejects.toThrow("relative paths");
  const invalid = new VortexifyClient({ ...config, development: true, devProxyPath: "//other.example" }, () => null, undefined, "dev-proxy");
  await expect(invalid.runApi("sales")).rejects.toThrow("same-origin path prefix");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("uses the local proxy in development without browser credentials", async () => {
  let context: VortexifyContextValue;
  function Consumer() { context = useVortexify(); return <span>{String(context.ready)}</span>; }
  const container = document.createElement("div");
  const root = createRoot(container);
  const fetchMock = operationFetch().mockImplementation(async () => new Response('{"job_id":"job"}'));
  await act(async () => root.render(<VortexifyProvider config={{ orgId: "org", projectId: "project", baseUrl: "", development: true, mode: "run" }}><Consumer /></VortexifyProvider>));
  expect(container.textContent).toBe("true");
  expect(Object.keys(context!).sort()).toEqual(["agentManager", "client", "logout", "ready"]);
  await context!.client.startTransform("refresh", { enabled: true });
  const [url, request] = fetchMock.mock.calls[0];
  expect(String(url)).toBe(window.location.origin + "/__vortexify/api/v2/artifacts/functions/start_transform_function");
  expect(request?.headers).toEqual({ "Content-Type": "application/json" });
  expect(request?.credentials).toBe("omit");
  expect(JSON.parse(String(request?.body)).preview).toBe(true);
  await act(async () => root.render(<VortexifyProvider config={{ ...config, development: false }}><Consumer /></VortexifyProvider>));
  expect(container.textContent).toContain("Open this application through its published URL.");
  await act(async () => root.unmount());
});

it("surfaces proxy login failures without attempting iframe refresh", async () => {
  let context: VortexifyContextValue;
  function Consumer() { context = useVortexify(); return null; }
  const root = createRoot(document.createElement("div"));
  const postMessage = vi.spyOn(window.parent, "postMessage");
  operationFetch().mockImplementation(async () => new Response("", { status: 401 }));
  await act(async () => root.render(<VortexifyProvider config={{ ...config, development: true }}><Consumer /></VortexifyProvider>));
  await expect(context!.client.runApi("sales")).rejects.toThrow("vortexify login");
  expect(postMessage).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("keeps custom dev prefixes, typed inputs and non-secret org context", async () => {
  let context: VortexifyContextValue;
  function Consumer() { context = useVortexify(); return null; }
  const root = createRoot(document.createElement("div"));
  const fetchMock = operationFetch().mockImplementation(async () => new Response('{"ok":true}'));
  await act(async () => root.render(<VortexifyProvider config={{ ...config, development: true, devProxyPath: "/local/proxy", orgId: "org" }}><Consumer /></VortexifyProvider>));
  await context!.client.runApi("sales", { enabled: false, count: 0 });
  expect(String(fetchMock.mock.calls[0][0])).toBe(window.location.origin + "/local/proxy/api/v2/projects/project/apis/sales");
  expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ inputs: { enabled: false, count: 0 }, function_name: "sales", project_id: "project", org_id: "org", preview: true });
  await act(async () => root.unmount());
});

it("handshakes with the parent and accepts refreshed tokens only from that parent", async () => {
  vi.spyOn(window, "self", "get").mockReturnValue({} as Window & typeof globalThis);
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  const fetchMock = operationFetch().mockImplementation(async () => new Response('{"ok":true}'));
  let context: VortexifyContextValue;
  function Consumer() { context = useVortexify(); return <span>{String(context.ready)}</span>; }
  const container = document.createElement("div");
  const root = createRoot(container);
  const origin = "https://app.vortexify.app";
  await act(async () => root.render(<VortexifyProvider config={{ ...config, parentOrigin: origin, development: true }}><Consumer /></VortexifyProvider>));
  expect(postMessage).toHaveBeenCalledWith({ type: "IFRAME_READY" }, origin);
  expect(container.textContent).toBe("Opening application…");
  expect(context!).toBeUndefined();
  const data = { type: "RUNTIME_TOKEN", token: "one", org_id: "org" };
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: "https://other.vortexify.app", data })));
  expect(container.textContent).toBe("Opening application…");
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: "https://other.example", data })));
  expect(container.textContent).toBe("Opening application…");
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin, data })));
  expect(container.textContent).toBe("true");
  await context!.client.runApi("sales");
  expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer one" });
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin, data: { ...data, token: "two" } })));
  await context!.client.runApi("sales");
  expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer two" });
  fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
  await expect(context!.client.runApi("sales")).rejects.toThrow("HTTP 401");
  expect(postMessage).toHaveBeenCalledWith({ type: "REFRESH_TOKEN" }, origin);
  await act(async () => root.unmount());
});

it("does not mount application children when opened directly in production", async () => {
  const consumer = vi.fn(() => <span>Application UI</span>);
  const container = document.createElement("div");
  const root = createRoot(container);
  const fetchMock = operationFetch();
  const Consumer = consumer;
  await act(async () => root.render(<VortexifyProvider config={config}><Consumer /></VortexifyProvider>));
  expect(consumer).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(container.textContent).toBe("Open this application through its published URL.");
  await act(async () => root.unmount());
});

it("logout clears credentials, unmounts the app and ignores late tokens", async () => {
  vi.spyOn(window, "self", "get").mockReturnValue({} as Window & typeof globalThis);
  const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  const fetchMock = operationFetch();
  const origin = "https://orders.apps.vortexify.dev";
  let context: VortexifyContextValue;
  function Consumer() { context = useVortexify(); return <span>Application</span>; }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<VortexifyProvider config={{ ...config, mode: "run", parentOrigin: origin }}><Consumer /></VortexifyProvider>));
  const event = () => window.dispatchEvent(new MessageEvent("message", {source: window.parent, origin,
    data: {type: "RUNTIME_TOKEN", token: "token", org_id: "org"}}));
  await act(async () => { event(); });
  expect(container.textContent).toBe("Application");
  const previousClient = context!.client;
  await act(async () => { context!.logout(); context!.logout(); });
  expect(post.mock.calls.filter(([data]) => data.type === "LOGOUT")).toEqual([[{type: "LOGOUT"}, origin]]);
  expect(container.textContent).toBe("Signing out…");
  await act(async () => { event(); });
  expect(container.textContent).toBe("Signing out…");
  await expect(previousClient.runApi("sales")).rejects.toThrow("authentication is not ready");
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("logout does not sign out the CLI developer", async () => {
  const post = vi.spyOn(window.parent, "postMessage");
  let context: VortexifyContextValue;
  function Consumer() { context = useVortexify(); return <span>Development</span>; }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<VortexifyProvider config={{ ...config, development: true }}><Consumer /></VortexifyProvider>));
  expect(() => context!.logout()).toThrow("deployed applications");
  expect(post).not.toHaveBeenCalled();
  expect(container.textContent).toBe("Development");
  await act(async () => root.unmount());
});
