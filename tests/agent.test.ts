import { afterEach, describe, expect, it, vi } from "vitest";
import { VortexifyClient } from "../src/client.js";
import { AGENT_LIMITS } from "../src/agent.js";
const config = { baseUrl: "https://api.example", projectId: "project" };
const auth = { token: "token", orgId: "org" };
const client = () => new VortexifyClient(config, () => auth);
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of stream) result.push(item); return result; }
import { sse, streamResponse } from "./streams.js";
afterEach(() => vi.unstubAllGlobals());

describe("agent client and SSE", () => {
  it("is lazy, uses project auth, snapshots schemas, and never serializes handlers even with multipart configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(sse("done", {})));
    vi.stubGlobal("fetch", fetchMock);
    const execute = vi.fn().mockResolvedValue({ success: true });
    const action = { description: "Open a customer", parameters: { type: "object" as const }, execute };
    const request = new VortexifyClient({ ...config, inputFormat: "multipart" }, () => auth).runAgent("sales/support", {
      message: "Hello", data: { orders: [{ id: 1 }] }, actions: { open: action },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await collect(request)).toEqual([{ type: "done" }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.href).toBe("https://api.example/api/v2/artifacts/agents/run_agent");
    expect(init.headers).toEqual({ Authorization: "Bearer token", "Content-Type": "application/json", Accept: "text/event-stream" });
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(init.body)).toEqual({ message: "Hello", data: { orders: [{ id: 1 }] }, org_id: "org", project_id: "project", agent_name: "sales/support", actions: [{ name: "open", description: "Open a customer", parameters: { type: "object" } }] });
    expect(execute).not.toHaveBeenCalled();
    await expect(collect(request)).rejects.toThrow("only be consumed once");
  });

  it("passes the app preview mode explicitly on every agent message", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(streamResponse(sse("done", {}))));
    vi.stubGlobal("fetch", fetchMock);
    for (const mode of ["preview", "run"] as const) {
      await collect(new VortexifyClient({ ...config, mode }, () => auth).runAgent("support", { message: "Hello" }));
    }
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).preview).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty("preview");
  });
  it("decodes fragmented unicode, CRLF, CR, multiline data, comments and backend tool events", async () => {
    const text = ': keepalive\r\n\r\nevent: token\r\ndata: {\r\ndata: "text": "Hello 🌍"}\r\n\r\n'
      + sse("tool_call", { callId: "1", name: "search", target: "backend" }).replaceAll("\n", "\r")
      + sse("tool_call_arguments", { callId: "1", arguments: { query: "hello" }, complete: true })
      + sse("tool_call_result", { callId: "1", result: [1, 2] }) + sse("done", {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(text, 1)));
    const events = await collect(client().runAgent("support", { message: "Hello" }));
    expect(events.map(event => event.type)).toEqual(["token", "tool_call", "tool_call_arguments", "tool_call_result", "done"]);
    expect(events[0]).toEqual({ type: "token", text: "Hello 🌍" });
  });

  it.each([
    [sse("token", { text: "partial" }), "before a done"],
    ['event: token\ndata: nope\n\n', "Invalid JSON"],
    [sse("token", { text: 5 }), "Invalid agent event"],
    [sse("error", { message: "Model failed" }), "Model failed"],
    [sse("tool_call_arguments", { callId: "1", arguments: {}, complete: false }), "Invalid or unsupported"],
  ])("rejects a broken stream", async (body, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(body)));
    await expect(collect(client().runAgent("a", { message: "Hello" }))).rejects.toThrow(message);
  });

  it("requires SSE and cancels the response body on failure or early iterator return", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{}')));
    await expect(collect(client().runAgent("a", { message: "Hello" }))).rejects.toThrow("text/event-stream");
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(sse("token", { text: "hi" }))); }, cancel,
    }), { headers: { "Content-Type": "text/event-stream" } })));
    for await (const _event of client().runAgent("a", { message: "Hello" })) break;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("refreshes production auth without replaying the agent request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn();
    const request = new VortexifyClient(config, () => auth, refresh).runAgent("a", { message: "Hello" });
    await expect(collect(request)).rejects.toThrow("HTTP 401");
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels pending reads and enforces the total stream deadline", async () => {
    function stalled() { return new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } }); }
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => stalled()));
    const request = client().runAgent("a", { message: "Hello" });
    const collecting = collect(request);
    await new Promise(resolve => setTimeout(resolve, 0));
    request.cancel();
    await expect(collecting).rejects.toMatchObject({ name: "AbortError" });
    await expect(collect(client().runAgent("a", { message: "Hello", timeoutMs: 10 }))).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("honors cancelSignal before sending any request", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController(); controller.abort();
    await expect(collect(client().runAgent("a", { message: "Hello", cancelSignal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized snapshots, unsupported schemas and cross-origin endpoints", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(collect(client().runAgent("a", { message: "Hello", data: { rows: Array(101).fill(1) } }))).rejects.toThrow("100 items");
    await expect(collect(client().runAgent("a", { message: "x".repeat(AGENT_LIMITS.requestBytes) }))).rejects.toThrow("256 KiB");
    await expect(collect(client().runAgent("a", { message: "Hello", actions: { action: {
      description: "Action", execute: vi.fn(), parameters: { type: "object", properties: { id: { type: "string", pattern: "abc" } } } as never,
    } } }))).rejects.toThrow("Unsupported frontend action");
    await expect(collect(new VortexifyClient({ ...config, endpoints: { runAgent: "https://evil.example/run" } }, () => auth).runAgent("a", { message: "Hello" }))).rejects.toThrow("server origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it("rejects oversized SSE events and data that cannot be serialized safely", async () => {
  const fetchMock = vi.fn().mockResolvedValue(streamResponse('event: token\ndata: {"text":"' + 'a'.repeat(AGENT_LIMITS.eventCharacters) + '"}\n\n', AGENT_LIMITS.eventCharacters + 100));
  vi.stubGlobal("fetch", fetchMock);
  await expect(collect(client().runAgent("a", { message: "Hello" }))).rejects.toThrow("size limit");
  await expect(collect(client().runAgent("a", { message: "Hello", data: { invalid: Number.NaN } }))).rejects.toThrow("JSON values");
  const circular: Record<string, never> = {};
  Object.assign(circular, { circular });
  await expect(collect(client().runAgent("a", { message: "Hello", data: circular }))).rejects.toThrow("nesting depth");
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("serializes bounded action deadlines and rejects invalid deadlines before requesting", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => streamResponse(sse("done", {})));
  vi.stubGlobal("fetch", fetchMock);
  const action = { description: "Open", parameters: { type: "object" as const }, execute: () => ({ success: true as const }) };
  await collect(client().runAgent("support", { message: "Hi", actions: { open: { ...action, timeoutMs: 120000 } } }));
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).actions[0].timeoutMs).toBe(120000);
  for (const timeoutMs of [0, 999, 120001, 1000.5]) {
    await expect(collect(client().runAgent("support", { message: "Hi", actions: { open: { ...action, timeoutMs } } }))).rejects.toThrow("Action timeoutMs");
  }
  expect(fetchMock).toHaveBeenCalledOnce();
});
