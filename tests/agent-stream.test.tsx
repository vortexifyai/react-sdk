import { operationFetch } from "./streams.js";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { VortexifyProvider, useVortexify } from "../src/provider.js";
import type { VortexifyContextValue } from "../src/provider.js";
import type { FrontendActions } from "../src/agent.js";
import { sse, streamResponse } from "./streams.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const config = { orgId: "org", projectId: "project", development: true };
let root: Root | undefined;
const contexts: VortexifyContextValue[] = [];
function Consumer({ index = 0 }: { index?: number }) { contexts[index] = useVortexify(); return null; }
async function mount(two = false) {
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<VortexifyProvider config={config}><Consumer />{two && <Consumer index={1} />}</VortexifyProvider>));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; contexts.length = 0; vi.restoreAllMocks();
});
const call = (id: string, name: string, target = "frontend") => sse("tool_call", { callId: id, name, target });
const args = (id: string, arguments_: unknown) => sse("tool_call_arguments", { callId: id, arguments: arguments_, complete: true });
function action(execute = vi.fn().mockResolvedValue({ success: true })): FrontendActions {
  return { openCustomer: { description: "Open customer", parameters: {
    type: "object", properties: { customerId: { type: "string" } }, required: ["customerId"], additionalProperties: false,
  }, execute } };
}

const conversation = { id: "conv", resource_id: "support", visibility: "public", is_active: true };
function mockInteractive(body: string, failSubmission: boolean | number = false) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const expected = [...body.matchAll(/event: tool_call_arguments\ndata: ([^\n]+)/g)]
    .map(match => JSON.parse(match[1])).filter(event => event.complete).map(event => event.callId);
  const backend = [...body.matchAll(/event: tool_call\ndata: ([^\n]+)/g)].map(match => JSON.parse(match[1])).filter(event => event.target === "backend").map(event => event.callId);
  const remaining = new Set(expected.filter(id => !backend.includes(id)));
  const encoder = new TextEncoder();
  const send = (text: string) => controller.enqueue(encoder.encode(text));
  const response = new Response(new ReadableStream<Uint8Array>({ start(next) {
    controller = next;
    send(sse("init", { conversation_id: "conv", message_id: "msg", run_id: "run", conversation })
      + body.replace(sse("done", {}), ""));
  } }), { headers: { "Content-Type": "text/event-stream" } });
  const fetchMock = operationFetch().mockImplementation(async (url, options) => {
    if (String(url).endsWith("respond_to_tool_call")) {
      if (failSubmission) return new Response("", { status: typeof failSubmission === "number" ? failSubmission : 503 });
      const { call_id: callId, response: result } = JSON.parse(String(options?.body));
      send(sse("tool_call_result", { callId, result }));
      remaining.delete(callId);
      if (!remaining.size) { send(sse("done", {})); controller.close(); }
      return Response.json({ status: "responded", result });
    }
    if (String(url).endsWith("list_messages")) return Response.json({ items: [], next_offset: null });
    return response;
  });
  return { fetchMock, send, close: () => controller.close() };
}

it("keeps per-hook state while sharing the client, forwards proxy requests, and resets on each run", async () => {
  const fetchMock = operationFetch().mockImplementation(async () => streamResponse(sse("token", { text: "Hello" }) + sse("done", {})));
  await mount(true);
  expect(contexts[0].client).toBe(contexts[1].client);
  expect(contexts[0].agentManager).not.toBe(contexts[1].agentManager);
  await act(async () => contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Hello" })));
  expect(String(fetchMock.mock.calls[0][0])).toBe(window.location.origin + "/__vortexify/api/v2/artifacts/agents/run_agent");
  expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
  expect(contexts[0].agentManager.text).toBe("Hello");
  expect(contexts[1].agentManager.text).toBe("");
  expect(contexts[0].agentManager.isRunning).toBe(false);
  fetchMock.mockImplementation(async () => streamResponse(sse("token", { text: "Next" }) + sse("done", {})));
  await act(async () => contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Next" })));
  expect(contexts[0].agentManager.text).toBe("Next");
});

it("assembles interleaved arguments and executes only registered frontend calls, once", async () => {
  const execute = vi.fn().mockResolvedValue({ success: true });
  const body = call("f", "openCustomer") + call("b", "search", "backend")
    + sse("tool_call_arguments", { callId: "f", delta: '{"customerId":', complete: false })
    + args("b", { query: "hello" }) + sse("tool_call_result", { callId: "b", result: { found: 1 } })
    + sse("tool_call_arguments", { callId: "f", delta: '"123"}', complete: true })
    + call("f", "openCustomer") + args("f", { customerId: "123" }) + sse("token", { text: "Done" }) + sse("done", {});
  mockInteractive(body);
  await mount();
  await act(async () => contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Open", actions: action(execute) })));
  expect(execute).toHaveBeenCalledExactlyOnceWith({ customerId: "123" });
  expect(contexts[0].agentManager.tools).toMatchObject([
    { callId: "f", arguments: { customerId: "123" }, status: "success" },
    { callId: "b", result: { found: 1 }, status: "success" },
  ]);
  expect(contexts[0].agentManager.error).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(3); // Run, action response, refreshed history.
  const submission = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) => String(url).endsWith("respond_to_tool_call"));
  expect(JSON.parse(submission![1].body)).toMatchObject({ conversation_id: "conv", run_id: "run", call_id: "f", response: { success: true } });
});

it("isolates unknown actions, invalid arguments and handler failures in tool state", async () => {
  const execute = vi.fn().mockRejectedValue(new Error("Navigation failed"));
  const body = call("1", "missing") + args("1", {})
    + call("2", "openCustomer") + args("2", { customerId: 5 })
    + call("3", "openCustomer") + args("3", { customerId: "123" })
    + call("4", "openCustomer") + sse("done", {});
  mockInteractive(body);
  await mount();
  await act(async () => contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Open", actions: action(execute) })));
  expect(execute).toHaveBeenCalledTimes(1);
  expect(contexts[0].agentManager.tools.map(tool => tool.status)).toEqual(["failed", "failed", "failed", "failed"]);
  expect(contexts[0].agentManager.tools.map(tool => tool.error?.message)).toEqual([
    "Frontend action is not registered: missing.", "arguments.customerId must be string.", "Navigation failed", "Agent finished before the frontend action completed.",
  ]);
  expect(contexts[0].agentManager.error).toBeNull();
});

it("surfaces stream failures and does not classify them as cancellation", async () => {
  operationFetch().mockImplementation(async () => streamResponse(sse("token", { text: "Partial" }) + sse("error", { message: "Model failed" })));
  await mount();
  await act(async () => {
    await expect(contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Hello" }))).rejects.toThrow("Model failed");
  });
  expect(contexts[0].agentManager.error?.message).toBe("Model failed");
  expect(contexts[0].agentManager.text).toBe("Partial");
  expect(contexts[0].agentManager.isRunning).toBe(false);
});

it("cancel finishes a pending handler, prevents subsequent actions, and preserves canceled state", async () => {
  const execute = vi.fn().mockImplementation(() => new Promise(() => {}));
  mockInteractive(call("1", "openCustomer") + args("1", { customerId: "1" }) + call("2", "openCustomer") + args("2", { customerId: "2" }));
  await mount();
  let consuming!: Promise<void>;
  await act(async () => {
    consuming = contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Hello", actions: action(execute) }));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  });
  expect(contexts[0].agentManager.isRunning).toBe(true);
  await act(async () => { contexts[0].agentManager.cancel(); await consuming; });
  expect(execute).toHaveBeenCalledOnce();
  expect(contexts[0].agentManager.tools[0].status).toBe("canceled");
  expect(contexts[0].agentManager.error).toBeNull();
  expect(contexts[0].agentManager.isRunning).toBe(false);
});

it("replaces an active stream without allowing stale text or failures to overwrite the new run", async () => {
  const fetchMock = operationFetch().mockImplementationOnce(async () => new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } }))
    .mockImplementationOnce(async () => streamResponse(sse("token", { text: "New run" }) + sse("done", {})));
  await mount();
  let old!: Promise<void>;
  await act(async () => {
    old = contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Old" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  });
  await act(async () => {
    await contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "New" }));
    await old;
  });
  expect(contexts[0].agentManager.text).toBe("New run");
  expect(contexts[0].agentManager.error).toBeNull();
});

it("cancels on unmount and releases the response stream", async () => {
  const cancel = vi.fn();
  operationFetch().mockImplementation(async () => new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "text/event-stream" } }));
  await mount();
  let consuming!: Promise<void>;
  await act(async () => {
    consuming = contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Hello" }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });
  await act(async () => { root!.unmount(); root = undefined; await consuming; });
  expect(cancel).toHaveBeenCalledOnce();
});

it("applies the total deadline to a pending frontend handler", async () => {
  const execute = vi.fn().mockImplementation(() => new Promise(() => {}));
  mockInteractive(call("1", "openCustomer") + args("1", { customerId: "123" }));
  await mount();
  await act(async () => {
    await expect(contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Hello", timeoutMs: 20, actions: action(execute) }))).rejects.toMatchObject({ name: "TimeoutError" });
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(contexts[0].agentManager.error?.name).toBe("TimeoutError");
  expect(contexts[0].agentManager.isRunning).toBe(false);
});

it("rejects tool ID reuse and references to undeclared calls", async () => {
  const fetchMock = operationFetch().mockImplementation(async () => streamResponse(call("1", "openCustomer") + call("1", "anotherAction") + sse("done", {})));
  await mount();
  await act(async () => {
    await expect(contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Hello" }))).rejects.toThrow("reused a tool call ID");
  });
  fetchMock.mockImplementation(async () => streamResponse(args("unknown", {}) + sse("done", {})));
  await act(async () => {
    await expect(contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Hello" }))).rejects.toThrow("unknown tool call");
  });
});

it("enforces required fields, extra properties, nested array items, and enum values before dispatch", async () => {
  const execute = vi.fn().mockResolvedValue({ success: true });
  const actions: FrontendActions = { update: {
    description: "Update selection", parameters: { type: "object", required: ["items"], additionalProperties: false, properties: {
      items: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "integer", enum: [1, 2] } }, additionalProperties: false } },
    } }, execute,
  } };
  const body = call("1", "update") + args("1", {})
    + call("2", "update") + args("2", { items: [], unexpected: true })
    + call("3", "update") + args("3", { items: [{ id: 3 }] })
    + call("4", "update") + args("4", { items: [{ id: 1 }] }) + sse("done", {});
  mockInteractive(body);
  await mount();
  await act(async () => contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Hello", actions })));
  expect(execute).toHaveBeenCalledExactlyOnceWith({ items: [{ id: 1 }] });
  expect(contexts[0].agentManager.tools.map(tool => tool.status)).toEqual(["failed", "failed", "failed", "success"]);
});

it("keeps reading and honors a server timeout while a frontend handler never settles", async () => {
  const execute = vi.fn().mockImplementation(() => new Promise(() => {}));
  const stream = mockInteractive(call("1", "openCustomer") + args("1", { customerId: "123" }));
  await mount();
  let consuming!: Promise<void>;
  await act(async () => {
    consuming = contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Hello", actions: action(execute) }));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    stream.send(sse("tool_call_result", { callId: "1", result: { success: false, message: "Tool timed out" } }) + sse("token", { text: "I could not confirm navigation." }) + sse("done", {}));
    stream.close();
    await consuming;
  });
  expect(contexts[0].agentManager.tools[0]).toMatchObject({ status: "failed", error: { message: "Tool timed out" } });
  expect(contexts[0].agentManager.text).toBe("I could not confirm navigation.");
  expect(stream.fetchMock.mock.calls.filter(([url]) => String(url).endsWith("respond_to_tool_call"))).toHaveLength(0);
});

it("reports explicit failures and invalid return values to the agent", async () => {
  const execute = vi.fn().mockResolvedValueOnce({ success: false, message: "Order is not visible", data: { orderId: "1" } }).mockResolvedValueOnce(undefined);
  const stream = mockInteractive(call("1", "openCustomer") + args("1", { customerId: "1" }) + call("2", "openCustomer") + args("2", { customerId: "2" }));
  await mount();
  await act(async () => contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Hello", actions: action(execute) })));
  const results = stream.fetchMock.mock.calls.filter(([url]) => String(url).endsWith("respond_to_tool_call")).map(([, options]) => JSON.parse(String(options?.body)).response);
  expect(results[0]).toEqual({ success: false, message: "Order is not visible", data: { orderId: "1" } });
  expect(results[1].success).toBe(false);
  expect(contexts[0].agentManager.tools.every(tool => tool.status === "failed")).toBe(true);
});

it("surfaces response submission failures", async () => {
  mockInteractive(call("1", "openCustomer") + args("1", { customerId: "1" }), true);
  await mount();
  await act(async () => {
    await expect(contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Hello", actions: action() }))).rejects.toThrow("HTTP 503");
  });
  expect(contexts[0].agentManager.error?.message).toBe("HTTP 503");
});

it("follows the canonical result when a timeout wins a late submission race", async () => {
  const stream = mockInteractive(call("1", "openCustomer") + args("1", { customerId: "1" }), 409);
  await mount();
  let consuming!: Promise<void>;
  await act(async () => {
    consuming = contexts[0].agentManager.consume(contexts[0].client.runAgent("support", { message: "Hello", actions: action() }));
    await vi.waitFor(() => expect(stream.fetchMock.mock.calls.some(([url]) => String(url).endsWith("respond_to_tool_call"))).toBe(true));
    stream.send(sse("tool_call_result", { callId: "1", result: { success: false, message: "Deadline passed; outcome unknown" } }) + sse("done", {}));
    stream.close();
    await consuming;
  });
  expect(contexts[0].agentManager.tools[0]).toMatchObject({ status: "failed", error: { message: "Deadline passed; outcome unknown" } });
  expect(contexts[0].agentManager.error).toBeNull();
});
