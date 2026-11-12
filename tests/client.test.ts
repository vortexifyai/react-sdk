import { afterEach, describe, expect, it, vi } from "vitest";
import { VortexifyClient } from "../src/client.js";
import { createVortexifyConfig } from "../src/config.js";
import { readRuntimeAuth, validateParentOrigin } from "../src/auth.js";

const config = { baseUrl: "https://server.example/v1", projectId: "project", appId: "app", appVersionId: "version" };
const auth = { token: "token", orgId: "org" };
afterEach(() => vi.unstubAllGlobals());

describe("service requests", () => {
  it("preserves customer exceptions from failed Lambda invocations", async () => {
    const result = { success: false, job_id: "job", result: { success: false,
      error: { type: "ValueError", message: "Purchase order is already received" } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(result))));
    await expect(new VortexifyClient(config, () => auth).runApi("receive_order"))
      .rejects.toMatchObject({ message: "Purchase order is already received", response: result });
  });
  it.each([
    [{ development: true, mode: "run" as const }, true],
    [{ mode: "preview" as const }, true],
    [{ mode: "run" as const }, false],
  ])("selects the database environment for API calls: %j", async (environment, preview) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"result":true}'));
    vi.stubGlobal("fetch", fetchMock);
    await new VortexifyClient({ ...config, ...environment }, () => auth).runApi("orders");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.preview === true).toBe(preview);
  });

  it.each([
    ['{"message":"API runtime is not ready; build it through the CLI"}', "API runtime is not ready; build it through the CLI"],
    ["<html>Bad gateway</html>", "HTTP 400"],
    ['{"message":{"nested":"invalid"}}', "HTTP 400"],
  ])("preserves server errors with a non-JSON fallback", async (body, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {status: 400})));
    await expect(new VortexifyClient(config, () => auth).runApi("orders")).rejects.toMatchObject({message, status:400});
  });

  it("calls APIs by name without a resource lookup and unwraps typed JSON results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true,"job_id":"job","result":{"answer":42}}'));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new VortexifyClient(config, () => auth).runApi("sales/summary", { count: 0, enabled: false });
    expect(result).toEqual({ answer: 42 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url.href).toBe("https://server.example/api/v2/projects/project/apis/sales%2Fsummary");
    expect(JSON.parse(request.body)).toEqual({ org_id: "org", project_id: "project", function_name: "sales/summary", inputs: { count: 0, enabled: false } });
  });
  it.each([{ summary: { total: 50 }, orders: [] }, null, false, 0, "", [1, 2], { result: "user field", success: false }])(
    "returns the actual API value from the invocation and runtime envelopes: %j", async value => {
      const runtime = { contract_version: 1, operation: "api", job_id: "job", success: true, status: "success", result: value };
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, job_status: "success", job_id: "job", result: runtime })));
      vi.stubGlobal("fetch", fetchMock);
      expect(await new VortexifyClient(config, () => auth).runApi("sales")).toEqual(value);
    },
  );
  it("throws on a failed runtime envelope and retains execution details", async () => {
    const envelope = { success: true, job_id: "job", result: {
      contract_version: 1, operation: "api", job_id: "job", success: false, status: "failed", error: { message: "Runtime execution failed" },
    } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope))));
    await expect(new VortexifyClient(config, () => auth).runApi("sales")).rejects.toMatchObject({
      message: "Runtime execution failed", response: envelope,
    });
  });
  it("routes local preview executions separately from deployed executions", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('{"success":true,"job_id":"job","result":{}}')));
    vi.stubGlobal("fetch", fetchMock);
    const preview = new VortexifyClient({ ...config, mode: "preview" }, () => auth);
    await preview.runApi("sales");
    await preview.startTransform("refresh");
    expect(fetchMock.mock.calls.map(([, request]) => JSON.parse(request.body).preview)).toEqual([true, true]);
    await new VortexifyClient({ ...config, mode: "run" }, () => auth).runApi("sales");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty("preview");
  });
  it("reads saved analysis data with project scope and pagination", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      job_id: "query", status: "success", data: [{ day: "Monday", total: 42 }], has_more: false,
    })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new VortexifyClient(config, () => auth);
    const result = await client.getAnalysisData("query", { limit: 100, offset: 100 });
    expect(result.data).toEqual([{ day: "Monday", total: 42 }]);
    expect(fetchMock.mock.calls[0][0].pathname).toBe("/api/v2/data/tables/get_analysis");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      org_id: "org", project_id: "project", job_id: "query", limit: 100, offset: 100,
    });
    await expect(client.getAnalysisData(" ")).rejects.toThrow("query ID");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("sends native service fields in multipart and normalizes transform job IDs", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{"id":"job"}'));
    vi.stubGlobal("fetch", fetchMock);
    let current = auth;
    const client = new VortexifyClient({ ...config, inputFormat: "multipart" }, () => current);
    expect(await client.startTransform("api", { count: 2 })).toMatchObject({ job_id: "job" });
    expect(Object.fromEntries(fetchMock.mock.calls[0][1].body)).toEqual({ org_id: "org", project_id: "project", function_name: "api", inputs: '{"count":2}' });
    current = { ...auth, token: "new" }; await client.startTransform("api");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer new");
  });
  it("rejects cross-origin endpoints before sending credentials there", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(new VortexifyClient({ ...config, endpoints: { startTransform: "https://evil.example" } }, () => auth).startTransform("api")).rejects.toThrow("server origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("refreshes on 401 without replaying execution", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 })); vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn();
    await expect(new VortexifyClient(config, () => auth, refresh).startTransform("api")).rejects.toThrow("HTTP 401");
    expect(refresh).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("accepts queued states, reads completed results, and validates transform ownership", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(async () => new Response('{"status":"queued","resource_type":"function","resource_id":"resource-id"}'))
      .mockImplementationOnce(async () => new Response('{"status":"success","resource_type":"function","resource_id":"resource-id","completed":true}'));
    vi.stubGlobal("fetch", fetchMock);
    const client = new VortexifyClient(config, () => auth);
    expect((await client.pollTransform("api", "job", { intervalMs: 1 })).status).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0].pathname).toMatch(/get_job$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).function_name).toBe('api');
    expect(fetchMock.mock.calls[1][0].pathname).toMatch(/get_job_results$/);
    fetchMock.mockResolvedValue(new Response('{"message":"Job does not belong to this transform"}', { status: 403 }));
    await expect(client.getTransformJob("api", "job")).rejects.toThrow("Job does not belong to this transform");
    const controller = new AbortController(); controller.abort();
    await expect(client.pollTransform("api", "job", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("iframe authentication", () => {
  it("requires both the trusted parent window and origin, and complete credentials", () => {
    const parent = {} as Window;
    const event = { source: parent, origin: "https://app.vortexify.app", data: {
      type: "RUNTIME_TOKEN", token: "token", org_id: "org",
    } } as unknown as MessageEvent;
    expect(readRuntimeAuth(event, parent, event.origin)).toEqual(auth);
    expect(readRuntimeAuth({ ...event, source: {} } as MessageEvent, parent, event.origin)).toBeNull();
    expect(readRuntimeAuth({ ...event, origin: "https://other.example" } as MessageEvent, parent, event.origin)).toBeNull();
    expect(readRuntimeAuth({ ...event, data: { ...event.data, token: "" } } as MessageEvent, parent, event.origin)).toBeNull();
    expect(readRuntimeAuth({ ...event, data: { type: "RUNTIME_TOKEN", token: "token" } } as MessageEvent, parent, event.origin)).toBeNull();
  });

  it("rejects wildcard and path-bearing parent origins", () => {
    expect(() => validateParentOrigin("*")).toThrow();
    expect(() => validateParentOrigin("https://app.vortexify.app/path")).toThrow();
    expect(validateParentOrigin("https://app.vortexify.app")).toBe("https://app.vortexify.app");
  });

  it.each(["https://vortexify.app", "https://app.vortexify.app", "https://tenant.app.vortexify.app"])(
    "accepts trusted HTTPS origins: %s", (origin) => {
      expect(validateParentOrigin(origin)).toBe(origin);
    },
  );

  it.each([
    "https://other.example", "https://evilvortexify.app", "https://vortexify.app.evil.example",
    "https://app.vortexify.app.evil.example", "http://app.vortexify.app", "null",
    "https://app.vortexify.app/", "https://vortexify.app@evil.example",
  ])("rejects untrusted origins even if they match the supplied parent origin: %s", (origin) => {
    expect(() => validateParentOrigin(origin)).toThrow();
    const parent = {} as Window;
    const event = { source: parent, origin, data: {
      type: "RUNTIME_TOKEN", token: "token", org_id: "org",
    } } as unknown as MessageEvent;
    expect(readRuntimeAuth(event, parent, origin)).toBeNull();
  });
});

it("maps Vite development configuration without accepting browser tokens", () => {
  const env = { DEV: true, VITE_VORTEXIFY_DEV_TOKEN: "ignored", VITE_VORTEXIFY_ORG_ID: "org", VITE_VORTEXIFY_PROJECT_ID: "project" };
  expect(createVortexifyConfig(env)).toMatchObject({ development: true, devProxyPath: "/__vortexify", orgId: "org", projectId: "project" });
  expect(createVortexifyConfig(env)).not.toHaveProperty("devToken");
  expect(createVortexifyConfig({}).development).toBe(false);
});

it("rejects proxy transport in production", async () => {
  const client = new VortexifyClient(config, () => null, undefined, "dev-proxy");
  await expect(client.runApi("sales")).rejects.toThrow("requires development mode");
});

it.each([null, false, 0, "", [1, 2], { result: { result: 5 }, success: false }])(
  "returns the public response unchanged: %j", async response => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      job_id: "job", type: "function-run", status: "success", completed: true, response,
    }))));
    expect(await new VortexifyClient(config, () => auth).runApi("orders")).toEqual(response);
  },
);

it.each([
  { status: "failed", completed: true, error: { message: "Invalid order" } },
  { status: "running", completed: false },
  { status: "success", completed: true },
])("rejects unsuccessful or missing public API responses: %j", async details => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    job_id: "job", type: "function-run", ...details,
  }))));
  await expect(new VortexifyClient(config, () => auth).runApi("orders")).rejects.toThrow();
});
