import type { AgentView } from "./agent-view.js";
import { conversationFromServer, messageFromServer } from "./conversations.js";
import type { AgentConversation, AgentMessage, ConversationOptions, Page, PageOptions } from "./conversations.js";
import { VortexifyError } from "./errors.js";
export { VortexifyError } from "./errors.js";
import { AgentRun, validateToolResult } from "./agent.js";
import type { AgentToolResult, RunAgentOptions } from "./agent.js";
import { DEFAULT_ENDPOINTS } from "./config.js";
import type { VortexifyConfig, Endpoints } from "./config.js";
import type { RuntimeAuth } from "./auth.js";
import { readJobEvents, waitForRetry } from "./job-stream.js";

export type Inputs = Record<string, string | number | boolean>;
export type JobStatus = "created" | "pending" | "queued" | "running" | "success" | "failed" | "stopped";
export interface Job { id?: string; job_id?: string; status: JobStatus; [key: string]: unknown }
export interface StartJobResponse { success?: boolean; job_id: string; [key: string]: unknown }
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface PollOptions extends RequestOptions {
  /** Delay between reconnections or fallback polls; streaming is preferred. */
  intervalMs?: number;
  onProgress?: (job: Job) => void;
}
export interface AnalysisData<Row = Record<string, unknown>> extends Job {
  data?: Row[];
  limit?: number;
  offset?: number;
  has_more?: boolean;
  result?: { rows: number; columns: { name: string; type: string }[]; result_truncated: boolean; [key: string]: unknown };
}
export interface AgentChart {
  query_id: string;
  name: string;
  config: { chartType: "Bar" | "StackedBar" | "GroupedBar" | "Line" | "MultiLine" | "Scatter" | "Pie"; xKey: string; yKeys: string[] };
  row_count: number;
}

function failureMessage(value: Record<string, unknown>, fallback: string): string {
  if (typeof value.message === "string" && value.message.trim()) return value.message;
  const nested = value.result && typeof value.result === "object" ? value.result as Record<string, unknown> : undefined;
  const error = nested?.error ?? value.error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

export class VortexifyClient {
  readonly endpoints: Endpoints;
  constructor(
    private config: VortexifyConfig,
    private getAuth: () => RuntimeAuth | null,
    private refreshAuth?: () => void,
    private transport: "authenticated" | "dev-proxy" = "authenticated",
    private getAgentView?: () => AgentView | null,
  ) {
    if (config.development) this.config = { ...config, mode: "preview" };
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...config.endpoints };
  }

  private prepare(endpoint: string, apiName: string, options: RequestOptions = {}) {
    const auth = this.getAuth();
    const useDevProxy = this.transport === "dev-proxy";
    if (useDevProxy && !this.config.development) throw new VortexifyError("Development proxy transport requires development mode.");
    if (!useDevProxy && !auth) throw new VortexifyError("Vortexify authentication is not ready.");
    if (!apiName.trim() || !this.config.projectId.trim()) throw new VortexifyError("A project ID and resource name are required.");
    const path = endpoint.replaceAll("{projectId}", encodeURIComponent(this.config.projectId))
      .replaceAll("{apiName}", encodeURIComponent(apiName))
      .replaceAll("{agentName}", encodeURIComponent(apiName));
    let url: URL;
    if (useDevProxy) {
      if (typeof window === "undefined") throw new VortexifyError("Development proxy requests require a browser.");
      const prefix = this.config.devProxyPath ?? "/__vortexify";
      if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(prefix)) {
        throw new VortexifyError("devProxyPath must be a same-origin path prefix without a trailing slash.");
      }
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path)) {
        throw new VortexifyError("Development proxy endpoints must be relative paths.");
      }
      const route = new URL(path, "https://vortexify.invalid/");
      url = new URL(prefix + route.pathname + route.search, window.location.origin);
    } else {
      if (!this.config.baseUrl) throw new VortexifyError("Authenticated requests require baseUrl.");
      url = new URL(path, this.config.baseUrl.replace(/\/?$/, "/"));
      if (url.origin !== new URL(this.config.baseUrl).origin) {
        throw new VortexifyError("Endpoints must belong to the configured server origin.");
      }
    }
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs ?? 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new VortexifyError("timeoutMs must be positive.");
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    signal.throwIfAborted();
    const headers: Record<string, string> = useDevProxy ? {} : { Authorization: `Bearer ${auth!.token}` };
    return { url, signal, headers, auth, useDevProxy };
  }

  private async checkResponse(response: Response, useDevProxy: boolean) {
    if (response.status === 401 && !useDevProxy) this.refreshAuth?.();
    if (response.status === 401 && useDevProxy) {
      throw new VortexifyError("Development proxy authentication failed. Run vortexify login and restart vortexify dev.", 401);
    }
    if (!response.ok) {
      let details: unknown;
      try { details = await response.json(); } catch { /* Proxies may return non-JSON errors. */ }
      const value = details && typeof details === "object" ? details as Record<string, unknown> : undefined;
      const message = typeof value?.message === "string" && value.message.trim() ? value.message : `HTTP ${response.status}`;
      throw new VortexifyError(message, response.status, details);
    }
  }

  private context() {
    const orgId = this.transport === "dev-proxy" ? this.config.orgId : this.getAuth()?.orgId ?? this.config.orgId;
    if (!orgId) throw new VortexifyError("orgId is required for service requests. Configure VITE_VORTEXIFY_ORG_ID in development.");
    return { org_id: orgId, project_id: this.config.projectId };
  }

  private async request<T>(endpoint: string, apiName: string, payload: Record<string, unknown>, options: RequestOptions = {}): Promise<T> {
    const { url, signal, headers, auth, useDevProxy } = this.prepare(endpoint, apiName, options);
    const values = { ...payload, ...this.context() };
    let body: string | FormData;
    if (this.config.inputFormat === "multipart") {
      body = new FormData();
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) body.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(values);
    }
    const response = await fetch(url, { method: "POST", body, signal, headers, credentials: "omit" });
    await this.checkResponse(response, useDevProxy);
    const result = await response.json();
    if (result?.success === false) {
      throw new VortexifyError(failureMessage(result, "Vortexify request failed."), response.status, result);
    }
    return result as T;
  }

  /** Creates a lazy, single-use SSE stream. No request is sent until it is consumed. */
  runAgent(agentName: string, options: RunAgentOptions): AgentRun {
    return new AgentRun({ ...options, timeoutMs: options.timeoutMs ?? this.config.timeoutMs ?? 300_000 }, async (payload, cancelSignal) => {
      const { url, signal, headers, useDevProxy } = this.prepare(this.endpoints.runAgent, agentName, {
        signal: cancelSignal, timeoutMs: options.timeoutMs ?? this.config.timeoutMs ?? 300_000,
      });
      headers["Content-Type"] = "application/json";
      headers.Accept = "text/event-stream";
      const body = JSON.stringify({ ...payload, agent_name: this.requireResourceName(agentName), ...this.context(), ...(this.config.mode === "preview" ? { preview: true } : {}) });
      const response = await fetch(url, { method: "POST", body, signal, headers, credentials: "omit" });
      try { await this.checkResponse(response, useDevProxy); }
      catch (error) {
        if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
        throw error;
      }
      return { response, signal };
    }, agentName, (conversationId, runId, callId, result, signal) =>
      this.respondToToolCall(agentName, conversationId, runId, callId, result, { signal }),
    async current => {
      if (!this.getAgentView) return current;
      if (Object.hasOwn(current.actions ?? {}, "get_current_view_context")) throw new VortexifyError("get_current_view_context is reserved by the SDK.");
      const readView = async (): Promise<AgentToolResult> => {
        const view = this.getAgentView!();
        if (!view) return { success: false, message: "No active view is registered." };
        const context = await view.getContext();
        // A navigation during an async read must not return stale page context.
        if (this.getAgentView!() !== view) return { success: false, message: "The active view changed while reading its context. Request context again." };
        return { success: true, data: { viewId: view.id, description: view.description ?? "", context } };
      };
      const snapshot = await readView();
      return { ...current, data: { ...current.data, current_view: snapshot.success ? snapshot.data ?? null : null },
        actions: { ...current.actions, get_current_view_context: {
          description: "Read the current page/view, its selection, filters and visible data. Request again after navigation or changes.",
          parameters: { type: "object", properties: {}, additionalProperties: false }, execute: readView,
        } },
      };
    });
  }

  /** Respond manually when consuming an AgentRun directly or building an approval UI. */
  async respondToToolCall(name: string, conversationId: string, runId: string, callId: string, response: AgentToolResult, options?: RequestOptions): Promise<{ status: "responded"; result: AgentToolResult }> {
    validateToolResult(response);
    return this.request(this.endpoints.respondToToolCall, name, {
      agent_name: this.requireResourceName(name), conversation_id: conversationId, run_id: runId, call_id: callId, response,
    }, options);
  }

  private requireResourceName(name: string): string {
    if (!name.trim()) throw new VortexifyError("A resource name is required.");
    return name;
  }

  async listAgentConversations(name: string, page: PageOptions = {}, options?: RequestOptions): Promise<Page<AgentConversation>> {
    const result = await this.request<{ items: Record<string, unknown>[]; next_offset: number | null }>(this.endpoints.listAgentConversations, name, { agent_name: this.requireResourceName(name), limit: 50, offset: 0, ...page }, options);
    return { items: result.items.map(conversationFromServer), nextOffset: result.next_offset };
  }

  async getAgentConversation(name: string, conversationId: string, options?: RequestOptions): Promise<AgentConversation> {
    return conversationFromServer(await this.request(this.endpoints.getAgentConversation, name, { agent_name: this.requireResourceName(name), conversation_id: conversationId }, options));
  }

  async listAgentMessages(name: string, conversationId: string, page: PageOptions = {}, options?: RequestOptions): Promise<Page<AgentMessage>> {
    const result = await this.request<{ items: Record<string, unknown>[]; next_offset: number | null }>(this.endpoints.listAgentMessages, name, { agent_name: this.requireResourceName(name), conversation_id: conversationId, limit: 50, offset: 0, ...page }, options);
    return { items: result.items.map(messageFromServer), nextOffset: result.next_offset };
  }

  async createAgentConversation(name: string, values: ConversationOptions = {}, options?: RequestOptions): Promise<AgentConversation> {
    return conversationFromServer(await this.request(this.endpoints.createAgentConversation, name, { agent_name: this.requireResourceName(name), ...values }, options));
  }

  async updateAgentConversation(name: string, conversationId: string, values: ConversationOptions, options?: RequestOptions): Promise<AgentConversation> {
    return conversationFromServer(await this.request(this.endpoints.updateAgentConversation, name, { agent_name: this.requireResourceName(name), conversation_id: conversationId, values }, options));
  }

  /** Read stored analysis rows by the query_id returned by an agent; never reruns SQL. */
  async getAnalysisData<Row = Record<string, unknown>>(
    queryId: string, page: PageOptions = {}, options?: RequestOptions,
  ): Promise<AnalysisData<Row>> {
    if (!queryId.trim()) throw new VortexifyError("An analysis query ID is required.");
    return this.request(this.endpoints.getAnalysisData, queryId, { job_id: queryId, limit: 1000, offset: 0, ...page }, options);
  }

  async runApi<T = unknown>(apiName: string, inputs: Inputs = {}, options?: RequestOptions): Promise<T> {
    if (!apiName.trim()) throw new VortexifyError("A resource name is required.");
    const result = await this.request<Record<string, unknown>>(this.endpoints.runApi, apiName, { function_name: apiName, inputs, ...(this.config.mode === "preview" ? { preview: true } : {}) }, options);
    // The server keeps invocation metadata; the runtime wraps the user's return value.
    const output = (result && "job_id" in result && "result" in result) ? result.result : result;
    if (output && typeof output === "object") {
      const runtime = output as Record<string, unknown>;
      if (runtime.contract_version === 1 && runtime.operation === "api" && typeof runtime.job_id === "string") {
        if (runtime.success === false || runtime.status === "failed" || runtime.status === "error") {
          throw new VortexifyError(failureMessage(runtime, "API execution failed."), undefined, result);
        }
        if (!("result" in runtime)) throw new VortexifyError("API execution returned no result.", undefined, result);
        return runtime.result as T;
      }
    }
    return output as T;
  }

  async startTransform(apiName: string, inputs: Inputs = {}, options?: RequestOptions): Promise<StartJobResponse> {
    const result = await this.request<StartJobResponse & { id?: string }>(this.endpoints.startTransform, apiName, { function_name: this.requireResourceName(apiName), inputs, ...(this.config.mode === "preview" ? { preview: true } : {}) }, options);
    const job_id = result.job_id ?? result.id;
    if (!job_id) throw new VortexifyError("The server did not return a job ID.", undefined, result);
    return { ...result, job_id };
  }

  /** Fetch one status snapshot, accepting a flat job or a { job } envelope. */
  async getTransformJob(apiName: string, jobId: string, options?: RequestOptions): Promise<Job> {
    if (!jobId.trim()) throw new VortexifyError("A job ID is required.");
    const result = await this.request<Job | { job: Job }>(this.endpoints.pollTransform, apiName, { job_id: jobId, function_name: this.requireResourceName(apiName) }, options);
    const job = (result && typeof result === "object" && "job" in result ? result.job : result) as Job;
    if (!job || !["created", "pending", "queued", "running", "success", "failed", "stopped"].includes(job.status)) {
      throw new VortexifyError("The server returned an invalid job status.", undefined, result);
    }
    if (job.resource_type !== "function") throw new VortexifyError("Job does not belong to this transform.");
    return job;
  }

  /** Wait for publication/downstream completion, then read authoritative results. */
  async pollTransform(apiName: string, jobId: string, options: PollOptions = {}): Promise<Job> {
    const intervalMs = options.intervalMs ?? 1_000;
    const timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new VortexifyError("Retry interval and timeout must be positive.");
    }
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    // Preserve the named-transform authorization check before subscribing to a job.
    const initial = await this.getTransformJob(apiName, jobId, { signal });
    let resultsAvailable = true, failures = 0, after = "0-0", progressFailed = false;
    const validate = (value: unknown): Job => {
      const job = value as Job;
      if (!job || !["created", "pending", "queued", "running", "success", "failed", "stopped"].includes(job.status)) {
        throw new VortexifyError("The server returned an invalid job status.");
      }
      if (job.resource_type !== "function" || (job.job_id && job.job_id !== jobId)
        || (initial.resource_id && job.resource_id !== initial.resource_id)) {
        throw new VortexifyError("Job does not belong to this transform.", 403);
      }
      return job;
    };
    const readSnapshot = async (existing?: Job): Promise<Job> => {
      if (resultsAvailable) {
        try {
          return validate(await this.request(this.endpoints.getTransformResults, apiName,
            { job_id: jobId }, { signal }));
        } catch (error) {
          // Older dev proxies/servers don't expose the results route. Keep the
          // raw job completion flags rather than treating execution success as publication.
          if (!(error instanceof VortexifyError) || error.status !== 404) throw error;
          resultsAvailable = false;
        }
      }
      const job = validate(existing ?? await this.getTransformJob(apiName, jobId, { signal }));
      const config = job.config as Record<string, unknown> | undefined;
      const completed = ["failed", "stopped"].includes(job.status) || (job.status === "success"
        && !!config?.watcher_complete && config.preview_chain_complete !== false);
      return { ...job, completed };
    };
    const report = (job: Job) => {
      try { options.onProgress?.(job); }
      catch (error) { progressFailed = true; throw error; }
    };
    let job = await readSnapshot(initial);
    report(job);
    while (job.completed !== true) {
      if (failures < 3) {
        try {
          const prepared = this.prepare(this.endpoints.streamTransform, apiName, { signal, timeoutMs });
          const response = await fetch(prepared.url, { method: "POST", credentials: "omit", signal: prepared.signal,
            headers: { ...prepared.headers, "Content-Type": "application/json", Accept: "text/event-stream" },
            body: JSON.stringify({ ...this.context(), job_id: jobId, last_event_id: after }) });
          try { await this.checkResponse(response, prepared.useDevProxy); }
          catch (error) {
            if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
            throw error;
          }
          for await (const event of readJobEvents(response, prepared.signal)) {
            if (event.id) after = event.id;
            if (event.type === "error") throw new VortexifyError("Job stream interrupted.");
            if (event.type !== "progress" && event.type !== "done") continue;
            // A done event is only a notification. Always verify using a fresh read.
            if (event.type === "done") break;
            const snapshot = validate(event.data);
            report(snapshot);
            if (snapshot.completed === true) break;
          }
        } catch (error) {
          signal.throwIfAborted();
          if (progressFailed || (error instanceof VortexifyError && [401, 403].includes(error.status ?? 0))) throw error;
          if (error instanceof VortexifyError && [404, 405, 501].includes(error.status ?? 0)) failures = 3;
        }
        signal.throwIfAborted();
        job = await readSnapshot();
        report(job);
        failures++;
      } else {
        job = await readSnapshot();
        report(job);
      }
      if (job.completed !== true) await waitForRetry(intervalMs, signal);
    }
    return job;
  }
}
