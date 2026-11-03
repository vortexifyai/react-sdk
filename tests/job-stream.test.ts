import { afterEach, describe, expect, it, vi } from "vitest";
import { VortexifyClient } from "../src/client.js";
import { readJobEvents } from "../src/job-stream.js";

const config = { baseUrl: "https://server.example", projectId: "project" };
const auth = { token: "token", orgId: "org" };
const initial = { id: "job", status: "queued", resource_type: "function", resource_id: "transform", config: {} };
const pending = { job_id: "job", status: "success", resource_type: "function", resource_id: "transform", completed: false, stage: "schema-discovery" };
const completed = { ...pending, completed: true, stage: "completed", result: { outputs: ["orders"] } };
const json = (value: unknown) => new Response(JSON.stringify(value));
const sse = (value: string) => new Response(value, { headers: { "Content-Type": "text/event-stream" } });
const progress = (value: unknown, id = "1-0") => `id: ${id}\nevent: progress\ndata: ${JSON.stringify(value)}\n\n`;
type Route = (init: RequestInit) => Response | Promise<Response>;
function install(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
    const route = url.pathname.split("/").at(-1)!;
    if (routes[route]) return routes[route](init);
    if (route === "get_job") return json(initial);
    throw new Error(`Unexpected request: ${route}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe("transform job streaming", () => {
  it("streams progress and fetches final results instead of polling raw job success", async () => {
    let reads = 0;
    const fetchMock = install({
      get_job_results: () => json(++reads === 1 ? pending : completed),
      stream_job_status: init => {
        expect(init.headers).toMatchObject({ Authorization: "Bearer token", Accept: "text/event-stream" });
        expect(JSON.parse(init.body as string)).toMatchObject({ job_id: "job", org_id: "org", project_id: "project", last_event_id: "0-0" });
        return sse(progress(pending) + 'event: done\ndata: {}\n\n');
      },
    });
    const updates = vi.fn();
    const result = await new VortexifyClient(config, () => auth).pollTransform("sales", "job", { onProgress: updates });
    expect(result).toEqual(completed);
    expect(reads).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4); // ownership, initial results, stream, final results
    expect(updates.mock.calls.map(([job]) => job.completed)).toEqual([false, false, true]);
  });

  it("reconnects with the last event ID and fresh credentials after EOF", async () => {
    let reads = 0, streams = 0, token = "old";
    install({
      get_job_results: () => json(++reads < 3 ? pending : completed),
      stream_job_status: init => {
        streams++;
        if (streams === 1) { token = "new"; return sse(progress(pending, "9-1")); }
        expect(JSON.parse(init.body as string).last_event_id).toBe("9-1");
        expect(init.headers).toMatchObject({ Authorization: "Bearer new" });
        return sse('event: done\ndata: {}\n\n');
      },
    });
    expect((await new VortexifyClient(config, () => ({ ...auth, token })).pollTransform("sales", "job", { intervalMs: 1 })).completed).toBe(true);
    expect(streams).toBe(2);
  });

  it("verifies a done notification and keeps waiting when publication is unfinished", async () => {
    let reads = 0, streams = 0;
    install({ get_job_results: () => json(++reads < 3 ? pending : completed),
      stream_job_status: () => { streams++; return sse('event: done\ndata: {}\n\n'); } });
    expect(await new VortexifyClient(config, () => auth).pollTransform("sales", "job", { intervalMs: 1 })).toEqual(completed);
    expect(streams).toBe(2);
  });

  it("does not poll while a healthy stream stays open", async () => {
    let reads = 0;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = install({ get_job_results: () => json(++reads === 1 ? pending : completed),
      stream_job_status: () => new Response(new ReadableStream({ start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode(progress(pending)));
      } }), { headers: { "Content-Type": "text/event-stream" } }) });
    let received!: () => void;
    const ready = new Promise<void>(resolve => { received = resolve; });
    let updates = 0;
    const waiting = new VortexifyClient(config, () => auth).pollTransform("sales", "job", {
      intervalMs: 1, onProgress: () => { if (++updates === 2) received(); },
    });
    await ready;
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    stream.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n'));
    expect(await waiting).toEqual(completed);
  });

  it("uses the same-origin dev proxy without exposing a bearer token", async () => {
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:5173" } });
    let reads = 0;
    const fetchMock = install({ get_job_results: () => json(++reads === 1 ? pending : completed),
      stream_job_status: init => {
        expect(init.headers).not.toHaveProperty("Authorization");
        expect(JSON.parse(init.body as string)).toMatchObject({ org_id: "org", project_id: "project" });
        return sse('event: done\ndata: {}\n\n');
      } });
    const client = new VortexifyClient({ projectId: "project", orgId: "org", development: true }, () => null, undefined, "dev-proxy");
    expect(await client.pollTransform("sales", "job")).toEqual(completed);
    expect(fetchMock.mock.calls.every(([url]) => url.origin === "http://127.0.0.1:5173" && url.pathname.startsWith('/__vortexify/'))).toBe(true);
  });

  it("surfaces progress callback exceptions without reconnecting", async () => {
    const fetchMock = install({ get_job_results: () => json(pending), stream_job_status: () => sse(progress(pending)) });
    let updates = 0;
    const failure = new Error("UI callback failed");
    await expect(new VortexifyClient(config, () => auth).pollTransform("sales", "job", {
      onProgress: () => { if (++updates === 2) throw failure; },
    })).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("falls back for an older proxy, waiting for watcher and downstream completion flags", async () => {
    let reads = 0, streams = 0;
    install({
      get_job: () => json(++reads === 1 ? initial : { ...initial, status: "success", config: { watcher_complete: true, preview_chain_complete: reads >= 3 } }),
      get_job_results: () => new Response("Not found", { status: 404 }),
      stream_job_status: () => { streams++; return new Response("Not found", { status: 404 }); },
    });
    const result = await new VortexifyClient(config, () => auth).pollTransform("sales", "job", { intervalMs: 1 });
    expect(result.completed).toBe(true);
    expect(reads).toBe(3);
    expect(streams).toBe(1);
  });

  it.each([401, 403])("does not retry authentication/permission failure %i", async status => {
    const fetchMock = install({ get_job_results: () => json(pending),
      stream_job_status: () => new Response("Denied", { status }) });
    const refresh = vi.fn();
    await expect(new VortexifyClient(config, () => auth, refresh).pollTransform("sales", "job")).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it("rejects a job belonging to another transform before opening a stream", async () => {
    const fetchMock = install({ get_job_results: () => json({ ...pending, resource_id: "other" }) });
    await expect(new VortexifyClient(config, () => auth).pollTransform("sales", "job")).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failed", "stopped"])("returns an already completed %s job without subscribing", async status => {
    const fetchMock = install({ get_job_results: () => json({ ...completed, status }) });
    expect((await new VortexifyClient(config, () => auth).pollTransform("sales", "job")).status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels an open response body without cancelling the backend job", async () => {
    const controller = new AbortController(), cancel = vi.fn();
    const fetchMock = install({ get_job_results: () => json(pending), stream_job_status: () => {
      return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(progress(pending))); }, cancel }),
        { headers: { "Content-Type": "text/event-stream" } });
    } });
    let updates = 0;
    await expect(new VortexifyClient(config, () => auth).pollTransform("sales", "job", {
      signal: controller.signal, onProgress: () => { if (++updates === 2) controller.abort(); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("applies the total timeout to an idle stream and releases its reader", async () => {
    const cancel = vi.fn();
    install({ get_job_results: () => json(pending), stream_job_status: () => new Response(new ReadableStream({ cancel }),
      { headers: { "Content-Type": "text/event-stream" } }) });
    await expect(new VortexifyClient(config, () => auth).pollTransform("sales", "job", { timeoutMs: 40 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancel).toHaveBeenCalled();
  });

  it("recovers from malformed events using an authoritative result read", async () => {
    let reads = 0;
    install({ get_job_results: () => json(++reads === 1 ? pending : completed),
      stream_job_status: () => sse('event: progress\ndata: bad-json\n\n') });
    expect(await new VortexifyClient(config, () => auth).pollTransform("sales", "job")).toEqual(completed);
  });

  it("falls back after three interrupted streams", async () => {
    let reads = 0, streams = 0;
    install({ get_job_results: () => json(++reads < 5 ? pending : completed),
      stream_job_status: () => { streams++; return sse('event: error\ndata: {"message":"retry"}\n\n'); } });
    expect(await new VortexifyClient(config, () => auth).pollTransform("sales", "job", { intervalMs: 1 })).toEqual(completed);
    expect(streams).toBe(3);
  });
});

it("parses chunked UTF-8, CRLF, comments, multiline data, and IDs", async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nid: 3-1\r\nevent: progress\r\ndata: {"text":\r\ndata: "café"}\r\n\r\n');
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
  const events = [];
  for await (const event of readJobEvents(response, new AbortController().signal)) events.push(event);
  expect(events).toEqual([{ type: "progress", id: "3-1", data: { text: "café" } }]);
});
