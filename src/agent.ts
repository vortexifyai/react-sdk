import type { AgentConversation, ConversationVisibility } from "./conversations.js";
import { conversationFromServer } from "./conversations.js";
import { VortexifyError } from "./errors.js";

export type JsonValue = null | string | number | boolean | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
/** Supported JSON Schema subset. Unknown keywords are rejected, rather than silently ignored. */
export interface ActionSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, ActionSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ActionSchema;
  enum?: JsonValue[];
}
export type AgentToolResult =
  | { success: true; message?: string; data?: JsonValue }
  | { success: false; message: string; data?: JsonValue };

export function validateToolResult(value: unknown): asserts value is AgentToolResult {
  json(value, "result");
  if (!object(value) || typeof value.success !== "boolean"
    || Object.keys(value).some(key => !["success", "message", "data"].includes(key))
    || (value.message !== undefined && typeof value.message !== "string")
    || (value.success === false && (typeof value.message !== "string" || !value.message.trim()))) {
    throw new VortexifyError("Frontend actions must return an AgentToolResult with success and a message on failure.");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > AGENT_LIMITS.requestBytes) throw new VortexifyError("Tool result exceeds the 256 KiB limit.");
}

export interface FrontendAction {
  description: string;
  parameters: ActionSchema;
  /** Server wait deadline, 1000–120000 ms; defaults to 60000. */
  timeoutMs?: number;
  execute: (arguments_: JsonObject) => AgentToolResult | Promise<AgentToolResult>;
}
export type FrontendActions = Record<string, FrontendAction>;
export interface RunAgentOptions {
  message: string;
  conversationId?: string;
  visibility?: ConversationVisibility;
  name?: string;
  data?: JsonObject;
  actions?: FrontendActions;
  cancelSignal?: AbortSignal;
  /** Total stream deadline; defaults to config.timeoutMs or five minutes. */
  timeoutMs?: number;
}
export type AgentEvent =
  | { type: "init"; conversationId: string; messageId: string; runId: string; conversation: AgentConversation }
  | { type: "token"; text: string }
  | { type: "tool_call"; callId: string; name: string; target: "frontend" | "backend" }
  | { type: "tool_call_arguments"; callId: string; delta?: string; arguments?: JsonObject; complete: boolean }
  | { type: "tool_call_result"; callId: string; result: JsonValue }
  | { type: "done" };
export const AGENT_LIMITS = { dataArrayItems: 100, requestBytes: 262_144, eventCharacters: 1_048_576 } as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function json(value: unknown, path = "data", limitArrays = false, depth = 0): asserts value is JsonValue {
  if (depth > 32) throw new VortexifyError(`${path} exceeds the maximum JSON nesting depth.`);
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) {
    if (limitArrays && value.length > AGENT_LIMITS.dataArrayItems) throw new VortexifyError(`${path} exceeds 100 items. Send a bounded data snapshot.`);
    value.forEach((item, i) => json(item, `${path}[${i}]`, limitArrays, depth + 1));
    return;
  }
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    for (const [key, item] of Object.entries(value)) json(item, `${path}.${key}`, limitArrays, depth + 1);
    return;
  }
  throw new VortexifyError(`${path} must contain only JSON values.`);
}
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key] as JsonValue)}`).join(",")}}`;
  return JSON.stringify(value);
}
function checkSchema(schema: ActionSchema, depth = 0): void {
  const keys = ["type", "description", "properties", "required", "additionalProperties", "items", "enum"];
  if (depth > 32 || !object(schema) || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)
    || Object.keys(schema).some(key => !keys.includes(key))) throw new VortexifyError("Unsupported frontend action parameter schema.");
  if (schema.description !== undefined && typeof schema.description !== "string") throw new VortexifyError("Schema description must be a string.");
  if (schema.properties !== undefined && (schema.type !== "object" || !object(schema.properties))) throw new VortexifyError("Schema properties require an object schema.");
  if (schema.required !== undefined && (schema.type !== "object" || !Array.isArray(schema.required) || !schema.required.every(key => typeof key === "string"))) throw new VortexifyError("Schema required must be an array of property names.");
  if (schema.additionalProperties !== undefined && (schema.type !== "object" || typeof schema.additionalProperties !== "boolean")) throw new VortexifyError("Schema additionalProperties must be a boolean on an object schema.");
  if (schema.items !== undefined && schema.type !== "array") throw new VortexifyError("Schema items require an array schema.");
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.length) throw new VortexifyError("Schema enum must be a non-empty array.");
    json(schema.enum, "schema.enum");
  }
  for (const child of Object.values(schema.properties ?? {})) checkSchema(child, depth + 1);
  if (schema.items !== undefined) checkSchema(schema.items, depth + 1);
}
/** Validates against the SDK's documented schema subset before a handler runs. */
export function validateActionArguments(value: unknown, schema: ActionSchema, path = "arguments"): asserts value is JsonValue {
  json(value, path);
  const matches = schema.type === "null" ? value === null
    : schema.type === "object" ? object(value)
    : schema.type === "array" ? Array.isArray(value)
    : schema.type === "integer" ? Number.isInteger(value)
    : typeof value === schema.type;
  if (!matches) throw new VortexifyError(`${path} must be ${schema.type}.`);
  if (schema.enum && !schema.enum.some(item => canonical(item) === canonical(value))) throw new VortexifyError(`${path} is not an allowed value.`);
  if (schema.type === "object" && object(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new VortexifyError(`${path}.${key} is required.`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateActionArguments(item, schema.properties![key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new VortexifyError(`${path}.${key} is not allowed.`);
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) value.forEach((item, i) => validateActionArguments(item, schema.items!, `${path}[${i}]`));
}

function event(type: string, raw: string): AgentEvent {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new VortexifyError(`Invalid JSON in agent event: ${type}.`); }
  if (!object(data)) throw new VortexifyError("Agent event data must be an object.");
  if (type === "error") throw new VortexifyError(typeof data.message === "string" ? data.message : "Agent stream failed.", undefined, data);
  if (type === "init" && typeof data.conversation_id === "string" && typeof data.message_id === "string" && typeof data.run_id === "string" && object(data.conversation)) {
    return { type, conversationId: data.conversation_id, messageId: data.message_id, runId: data.run_id, conversation: conversationFromServer(data.conversation) };
  }
  if (type === "done") return { type };
  if (type === "token" && typeof data.text === "string") return { type, text: data.text };
  if (typeof data.callId !== "string" || !data.callId) throw new VortexifyError(`Invalid agent event: ${type}.`);
  if (type === "tool_call" && typeof data.name === "string" && data.name && (data.target === "frontend" || data.target === "backend")) {
    return { type, callId: data.callId, name: data.name, target: data.target };
  }
  if (type === "tool_call_arguments" && typeof data.complete === "boolean"
    && (data.delta === undefined || typeof data.delta === "string")
    && (data.arguments === undefined || object(data.arguments))
    && !(data.delta !== undefined && data.arguments !== undefined)
    && (data.arguments === undefined || data.complete)) {
    if (data.arguments !== undefined) json(data.arguments, "arguments");
    return { type, callId: data.callId, complete: data.complete, delta: data.delta as string | undefined, arguments: data.arguments as JsonObject | undefined };
  }
  if (type === "tool_call_result" && Object.hasOwn(data, "result")) {
    json(data.result, "result");
    return { type, callId: data.callId, result: data.result };
  }
  throw new VortexifyError(`Invalid or unsupported agent event: ${type}.`);
}

/** Parses SSE across arbitrary UTF-8 chunks, LF/CRLF/CR, comments and multiline data. */
async function* readEvents(response: Response, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  if (response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream" || !response.body) {
    await response.body?.cancel();
    throw new VortexifyError("Agent endpoint must return a text/event-stream response body.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", type = "message", data: string[] = [], size = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let index: number;
      while ((index = buffer.search(/[\r\n]/)) >= 0) {
        // A CR at a chunk boundary may be the first half of CRLF.
        if (buffer[index] === "\r" && index === buffer.length - 1 && !chunk.done) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1));
        size += line.length;
        if (size > AGENT_LIMITS.eventCharacters) throw new VortexifyError("Agent event exceeds the size limit.");
        if (!line) {
          if (data.length) {
            const next = event(type, data.join("\n"));
            yield next;
            if (next.type === "done") return;
          }
          type = "message"; data = []; size = 0;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") type = value;
          if (field === "data") data.push(value);
        }
      }
      if (buffer.length + size > AGENT_LIMITS.eventCharacters) throw new VortexifyError("Agent event exceeds the size limit.");
      if (chunk.done) throw new VortexifyError("Agent stream ended before a done event.");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

type OpenStream = (payload: { message: string; data: JsonObject; actions: { name: string; description: string; parameters: ActionSchema; timeoutMs?: number }[]; conversation_id?: string; visibility?: ConversationVisibility; name?: string }, signal: AbortSignal) => Promise<{ response: Response; signal: AbortSignal }>;
/** A lazy single-use request. Consume through agentStream, or iterate directly and manage UI/actions yourself. */
export class AgentRun implements AsyncIterable<AgentEvent> {
  private controller = new AbortController();
  private started = false;
  private signal = this.controller.signal;
  private registered: FrontendActions = {};
  private options: RunAgentOptions;
  private identity?: { conversationId: string; runId: string };
  constructor(options: RunAgentOptions, private open: OpenStream, readonly agentName: string = "",
    private respond?: (conversationId: string, runId: string, callId: string, result: AgentToolResult, signal: AbortSignal) => Promise<unknown>,
    private prepareOptions?: (options: RunAgentOptions) => Promise<RunAgentOptions>,
  ) { this.options = options; }
  async respondToToolCall(callId: string, result: AgentToolResult): Promise<void> {
    validateToolResult(result);
    if (!this.identity || !this.respond) throw new VortexifyError("A tool response requires an initialized agent run.");
    await this.respond(this.identity.conversationId, this.identity.runId, callId, result, this.signal);
  }
  /** Used by the manager to apply its selected conversation or new-conversation defaults. */
  useConversation(defaults: { conversationId?: string; visibility?: ConversationVisibility; name?: string }): void {
    if (this.started) throw new VortexifyError("Cannot configure an agent request after consumption starts.");
    if (this.options.conversationId) return;
    if (this.options.visibility !== undefined || this.options.name !== undefined) return;
    this.options = { ...defaults, ...Object.fromEntries(Object.entries(this.options).filter(([, value]) => value !== undefined)) } as RunAgentOptions;
  }
  cancel(): void { this.controller.abort(); }
  get cancelSignal(): AbortSignal { return this.signal; }
  /** Handler definitions are retained locally, never serialized. */
  get actions(): FrontendActions { return this.registered; }
  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
    if (this.started) throw new VortexifyError("An agent request can only be consumed once.");
    this.started = true;
    const timeout = this.options.timeoutMs ?? 300_000;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new VortexifyError("timeoutMs must be positive.");
    const signal = AbortSignal.any([this.controller.signal, ...(this.options.cancelSignal ? [this.options.cancelSignal] : []), AbortSignal.timeout(timeout)]);
    this.signal = signal;
    signal.throwIfAborted();
    if (this.prepareOptions) {
      let abort: () => void = () => {};
      try {
        const canceled = new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        this.options = await Promise.race([this.prepareOptions(this.options), canceled]);
      } finally { signal.removeEventListener("abort", abort); }
    }
    signal.throwIfAborted();
    if (typeof this.options.message !== "string" || !this.options.message.trim()) throw new VortexifyError("An agent message is required.");
    if (this.options.data !== undefined && !object(this.options.data)) throw new VortexifyError("Agent data must be a JSON object.");
    json(this.options.data ?? {}, "data", true);
    const actions = Object.entries(this.options.actions ?? {}).map(([name, action]) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !action.description?.trim() || typeof action.execute !== "function" || action.parameters?.type !== "object") throw new VortexifyError("Frontend actions require a name, description, object parameter schema and execute handler.");
      if (action.timeoutMs !== undefined && (!Number.isInteger(action.timeoutMs) || action.timeoutMs < 1000 || action.timeoutMs > 120000)) throw new VortexifyError("Action timeoutMs must be an integer between 1000 and 120000.");
      checkSchema(action.parameters);
      const parameters = JSON.parse(JSON.stringify(action.parameters)) as ActionSchema;
      Object.defineProperty(this.registered, name, { value: { ...action, parameters }, enumerable: true });
      return { name, description: action.description, parameters, ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }) };
    });
    if (this.options.conversationId && (this.options.visibility !== undefined || this.options.name !== undefined)) throw new VortexifyError("Existing conversations must be edited through updateAgentConversation.");
    const payload = { message: this.options.message, data: this.options.data ?? {}, actions,
      conversation_id: this.options.conversationId, visibility: this.options.visibility, name: this.options.name };
    if (new TextEncoder().encode(JSON.stringify(payload)).length > AGENT_LIMITS.requestBytes) throw new VortexifyError("Agent request exceeds the 256 KiB limit.");
    const stream = await this.open(payload, signal);
    this.signal = stream.signal;
    for await (const event of readEvents(stream.response, stream.signal)) {
      if (event.type === "init") this.identity = { conversationId: event.conversationId, runId: event.runId };
      yield event;
    }
  }
}
