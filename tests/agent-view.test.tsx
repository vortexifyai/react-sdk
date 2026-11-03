// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { VortexifyProvider, useVortexify } from "../src/provider.js";
import { useAgentView, AgentViewContext } from "../src/agent-view.js";
import type { AgentView, AgentViewRegistry } from "../src/agent-view.js";
import type { VortexifyClient } from "../src/client.js";
import { operationFetch, sse, streamResponse } from "./streams.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | undefined;
let client: VortexifyClient;
const config = { orgId: "org", projectId: "project", development: true };
function Consumer() { client = useVortexify().client; return null; }
function Page({ id, filter }: { id: string; filter: string }) {
  useAgentView({ id, description: `The ${id} page`, getContext: () => ({ filter }) });
  return null;
}
async function render(id: string | null, filter = "all") {
  root ??= createRoot(document.createElement("div"));
  await act(async () => root!.render(<VortexifyProvider config={config}><Consumer />{id && <Page key={id} id={id} filter={filter} />}</VortexifyProvider>));
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.restoreAllMocks(); });

it("sends initial context and reads the latest render and page during an existing run", async () => {
  const fetchMock = operationFetch().mockImplementation(async () => streamResponse(sse("init", {
    conversation_id: "conv", message_id: "msg", run_id: "run", conversation: { id: "conv" },
  }) + sse("done", {})));
  await render("orders");
  const run = client.runAgent("support", { message: "Help", data: { extra: true } });
  const events = run[Symbol.asyncIterator]();
  await events.next();
  const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(payload.data).toEqual({ extra: true, current_view: { viewId: "orders", description: "The orders page", context: { filter: "all" } } });
  expect(payload.actions.map((action: { name: string }) => action.name)).toContain("get_current_view_context");
  await render("orders", "shipped");
  expect(await run.actions.get_current_view_context.execute({})).toMatchObject({ success: true, data: { viewId: "orders", context: { filter: "shipped" } } });
  await render("customer", "selected");
  expect(await run.actions.get_current_view_context.execute({})).toMatchObject({ success: true, data: { viewId: "customer", context: { filter: "selected" } } });
  await render(null);
  expect(await run.actions.get_current_view_context.execute({})).toEqual({ success: false, message: "No active view is registered." });
  await events.return?.(undefined);
});

it("old page cleanup cannot unregister a newer page", async () => {
  let active: AgentView | null = null;
  const registrations: AgentView[] = [];
  const registry: AgentViewRegistry = { register(view) {
    active = view; registrations.push(view);
    return () => { if (active === view) active = null; };
  } };
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<AgentViewContext.Provider value={registry}><Page key="old" id="old" filter="a" /><Page key="new" id="new" filter="b" /></AgentViewContext.Provider>));
  await act(async () => root!.render(<AgentViewContext.Provider value={registry}><Page key="new" id="new" filter="c" /></AgentViewContext.Provider>));
  expect(active).toBe(registrations[1]);
  expect(await active!.getContext()).toEqual({ filter: "c" });
});

it("rejects context from a page that unmounted during an asynchronous read", async () => {
  let resolve!: (value: { filter: string }) => void;
  function AsyncPage() {
    useAgentView({ id: "async", getContext: () => new Promise(done => { resolve = done; }) });
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<VortexifyProvider config={config}><Consumer /><AsyncPage /></VortexifyProvider>));
  const run = client.runAgent("support", { message: "Help" });
  const fetchMock = operationFetch().mockImplementation(async () => streamResponse(sse("done", {})));
  const consume = run[Symbol.asyncIterator]().next();
  await act(async () => { await Promise.resolve(); });
  await render("orders");
  resolve({ filter: "stale" });
  await consume;
  const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(payload.data.current_view).toBeNull();
  expect(await run.actions.get_current_view_context.execute({})).toMatchObject({ success: true, data: { viewId: "orders" } });
});

it("bounds a pending initial context read by the total run deadline", async () => {
  function PendingPage() {
    useAgentView({ id: "pending", getContext: () => new Promise(() => {}) });
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<VortexifyProvider config={config}><Consumer /><PendingPage /></VortexifyProvider>));
  const fetchMock = operationFetch();
  const events = client.runAgent("support", { message: "Help", timeoutMs: 20 })[Symbol.asyncIterator]();
  await expect(events.next()).rejects.toMatchObject({ name: "TimeoutError" });
  expect(fetchMock).not.toHaveBeenCalled();
});
