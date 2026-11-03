import type { VortexifyClient } from "./client.js";
import type { AgentConversation, AgentMessage, ConversationOptions, PageOptions } from "./conversations.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentRun, AGENT_LIMITS, validateActionArguments, validateToolResult } from "./agent.js";
import type { AgentToolResult, JsonObject, JsonValue } from "./agent.js";
import { VortexifyError } from "./errors.js";

export interface AgentTool {
  callId: string;
  name: string;
  target: "frontend" | "backend";
  status: "receiving" | "running" | "success" | "failed" | "canceled";
  argumentText: string;
  arguments?: JsonObject;
  result?: JsonValue;
  error?: Error;
}
export interface AgentManager {
  agentName: string | null;
  conversations: AgentConversation[];
  activeConversation: AgentConversation | null;
  messages: AgentMessage[];
  conversationId: string | null;
  messageId: string | null;
  runId: string | null;
  isLoading: boolean;
  nextConversationOffset: number | null;
  nextMessageOffset: number | null;
  loadConversations: (agentName: string, page?: PageOptions) => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  newConversation: (options?: ConversationOptions) => void;
  updateConversation: (options: ConversationOptions) => Promise<void>;
  text: string;
  tools: AgentTool[];
  isRunning: boolean;
  error: Error | null;
  /** Rejects on request/stream errors; user cancellation resolves normally. */
  consume: (request: AgentRun) => Promise<void>;
  cancel: () => void;
}
function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  // DOMException and errors from another realm need not inherit this realm's Error.
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    const error = new Error(value.message);
    if ("name" in value && typeof value.name === "string") error.name = value.name;
    return error;
  }
  return new Error(String(value));
}

/** Allows cancel/unmount to finish consumption even if a frontend handler never settles. */
async function withCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const canceled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([promise, canceled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Internal hook: useVortexify exposes its result without a separate public agent hook. */
export function useAgentManager(client: VortexifyClient | null): AgentManager {
  const [agentName, setAgentName] = useState<string | null>(null);
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<AgentConversation | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [nextConversationOffset, setNextConversationOffset] = useState<number | null>(null);
  const [nextMessageOffset, setNextMessageOffset] = useState<number | null>(null);
  const scope = useRef<{ agentName: string | null; conversationId: string | null; revision: number; draft: ConversationOptions }>({ agentName: null, conversationId: null, revision: 0, draft: { visibility: "public" } });
  const loading = useRef<AbortController | null>(null);
  const [text, setText] = useState("");
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const active = useRef<{ request: AgentRun; cancel: boolean } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loading.current?.abort();
      if (active.current) { active.current.cancel = true; active.current.request.cancel(); active.current = null; }
    };
  }, []);
  const cancel = useCallback(() => {
    const current = active.current;
    if (!current) return;
    current.cancel = true;
    current.request.cancel();
    if (mounted.current) {
      setIsRunning(false);
      setTools(previous => previous.map(tool => ["receiving", "running"].includes(tool.status) ? { ...tool, status: "canceled" } : tool));
    }
  }, []);
  const clearResponse = useCallback(() => {
    setText(""); setTools([]); setError(null); setMessageId(null); setRunId(null);
  }, []);
  const switchAgent = useCallback((name: string) => {
    if (!name.trim()) throw new VortexifyError("An agent name is required.");
    if (scope.current.agentName !== name) {
      cancel(); loading.current?.abort(); setIsLoading(false);
      const draft = scope.current.agentName === null ? scope.current.draft : { visibility: "public" as const };
      scope.current = { agentName: name, conversationId: null, revision: scope.current.revision + 1, draft };
      setAgentName(name); setActiveConversation(null); setMessages([]); setConversations([]);
      setNextConversationOffset(null); setNextMessageOffset(null); clearResponse();
    }
  }, [cancel, clearResponse]);
  const operation = useCallback(async (work: (signal: AbortSignal, live: () => boolean) => Promise<void>) => {
    loading.current?.abort();
    const controller = new AbortController(); loading.current = controller;
    const revision = scope.current.revision;
    const live = () => mounted.current && !controller.signal.aborted && scope.current.revision === revision;
    setIsLoading(true); setError(null);
    try { await work(controller.signal, live); }
    catch (failure) { if (live()) { setError(asError(failure)); throw failure; } }
    finally { if (loading.current === controller) { loading.current = null; if (mounted.current) setIsLoading(false); } }
  }, []);
  const loadConversations = useCallback(async (name: string, page: PageOptions = {}) => {
    if (!client) throw new VortexifyError("VortexifyProvider is required.");
    switchAgent(name);
    await operation(async (signal, live) => {
      const result = await client.listAgentConversations(name, page, { signal });
      if (live()) {
        setConversations(previous => (page.offset ?? 0) > 0 ? [...previous, ...result.items.filter(item => !previous.some(old => old.id === item.id))] : result.items);
        setNextConversationOffset(result.nextOffset);
      }
    });
  }, [client, switchAgent, operation]);
  const selectConversation = useCallback(async (id: string) => {
    const name = scope.current.agentName;
    if (!client || !name) throw new VortexifyError("Load an agent's conversations before selecting one.");
    cancel(); scope.current.revision++; clearResponse(); setActiveConversation(null); setMessages([]);
    scope.current.conversationId = null; setNextMessageOffset(null);
    await operation(async (signal, live) => {
      const [conversation, history] = await Promise.all([
        client.getAgentConversation(name, id, { signal }), client.listAgentMessages(name, id, {}, { signal }),
      ]);
      if (live()) { scope.current.conversationId = id; setActiveConversation(conversation); setMessages(history.items); setNextMessageOffset(history.nextOffset); }
    });
  }, [client, cancel, clearResponse, operation]);
  const loadMoreMessages = useCallback(async () => {
    const { agentName: name, conversationId: id } = scope.current;
    if (!client || !name || !id || nextMessageOffset === null) return;
    await operation(async (signal, live) => {
      const result = await client.listAgentMessages(name, id, { offset: nextMessageOffset }, { signal });
      if (live()) { setMessages(previous => [...previous, ...result.items]); setNextMessageOffset(result.nextOffset); }
    });
  }, [client, nextMessageOffset, operation]);
  const newConversation = useCallback((options: ConversationOptions = {}) => {
    cancel(); loading.current?.abort(); setIsLoading(false);
    scope.current = { ...scope.current, conversationId: null, revision: scope.current.revision + 1, draft: { visibility: "public", ...options } };
    setActiveConversation(null); setMessages([]); setNextMessageOffset(null); clearResponse();
  }, [cancel, clearResponse]);
  const previousClient = useRef(client);
  useEffect(() => {
    if (previousClient.current !== client) {
      previousClient.current = client;
      newConversation();
      scope.current.agentName = null;
      setAgentName(null); setConversations([]); setNextConversationOffset(null);
    }
  }, [client, newConversation]);
  const updateConversation = useCallback(async (options: ConversationOptions) => {
    const { agentName: name, conversationId: id } = scope.current;
    if (!client || !name || !id) throw new VortexifyError("Select a conversation before editing it.");
    await operation(async (signal, live) => {
      const updated = await client.updateAgentConversation(name, id, options, { signal });
      if (live()) { setActiveConversation(updated); setConversations(previous => previous.map(item => item.id === id ? updated : item)); }
    });
  }, [client, operation]);
  const consume = useCallback(async (request: AgentRun): Promise<void> => {
    if (!mounted.current) { request.cancel(); return; }
    switchAgent(request.agentName);
    request.useConversation(scope.current.conversationId ? { conversationId: scope.current.conversationId } : scope.current.draft);
    if (active.current?.request === request) throw new VortexifyError("This agent request is already being consumed.");
    if (active.current) { active.current.cancel = true; active.current.request.cancel(); }
    loading.current?.abort(); setIsLoading(false); scope.current.revision++;
    const current = { request, cancel: false };
    active.current = current;
    const calls = new Map<string, AgentTool>();
    const completedArguments = new Set<string>();
    const pendingActions = new Map<string, AbortController>();
    const submissions = new Set<Promise<void>>();
    let submissionError: unknown;
    let actionQueue = Promise.resolve();
    const live = () => mounted.current && active.current === current && !current.cancel;
    const publish = () => { if (live()) setTools(Array.from(calls.values(), tool => ({ ...tool }))); };
    setText(""); setTools([]); setError(null); setIsRunning(true);
    try {
      for await (const event of request) {
        if (!live()) break;
        request.cancelSignal.throwIfAborted();
        if (event.type === "init") {
          if (scope.current.conversationId !== event.conversationId) setMessages([]);
          scope.current.conversationId = event.conversationId;
          setActiveConversation(event.conversation); setMessageId(event.messageId); setRunId(event.runId);
          setConversations(previous => [event.conversation, ...previous.filter(item => item.id !== event.conversationId)]);
          continue;
        }
        if (event.type === "token") { setText(previous => previous + event.text); continue; }
        if (event.type === "done") {
          for (const tool of calls.values()) {
            if (tool.target === "frontend" && ["receiving", "running"].includes(tool.status)) {
              tool.status = "failed";
              tool.error = new VortexifyError("Agent finished before the frontend action completed.");
              pendingActions.get(tool.callId)?.abort();
            }
          }
          publish();
          const { agentName: name, conversationId: id } = scope.current;
          if (client && name && id) {
            const history = await client.listAgentMessages(name, id, {}, { signal: request.cancelSignal });
            if (live()) {
              setMessages(history.items); setNextMessageOffset(history.nextOffset);
              setActiveConversation(previous => previous ? { ...previous, isActive: false } : previous);
              setConversations(previous => previous.map(item => item.id === id ? { ...item, isActive: false } : item));
            }
          }
          continue;
        }
        if (event.type === "tool_call") {
          const existing = calls.get(event.callId);
          if (existing && (existing.name !== event.name || existing.target !== event.target)) throw new VortexifyError("Agent reused a tool call ID for a different tool.");
          if (!existing) calls.set(event.callId, { ...event, status: "receiving", argumentText: "" });
          publish();
          continue;
        }
        const tool = calls.get(event.callId);
        if (!tool) throw new VortexifyError(`Agent referenced an unknown tool call: ${event.callId}.`);
        if (event.type === "tool_call_result") {
          pendingActions.get(event.callId)?.abort();
          if (tool.target === "frontend") {
            validateToolResult(event.result);
            tool.status = event.result.success ? "success" : "failed";
            tool.error = event.result.success ? undefined : new VortexifyError(event.result.message);
          } else tool.status = "success";
          tool.result = event.result;
          publish(); continue;
        }
        // Repeated argument completion must never execute an action twice.
        if (completedArguments.has(event.callId)) continue;
        tool.argumentText += event.delta ?? "";
        if (tool.argumentText.length > AGENT_LIMITS.eventCharacters) throw new VortexifyError("Tool arguments exceed the size limit.");
        if (!event.complete) { publish(); continue; }
        completedArguments.add(event.callId);
        if (tool.target === "frontend") {
          const controller = new AbortController();
          pendingActions.set(tool.callId, controller);
          const executeAndRespond = async () => {
            if (!live() || controller.signal.aborted || request.cancelSignal.aborted) return;
            let result: AgentToolResult;
            try {
              const args: unknown = event.arguments ?? JSON.parse(tool.argumentText || "{}");
              if (!args || typeof args !== "object" || Array.isArray(args)) throw new VortexifyError("Tool arguments must be a JSON object.");
              tool.arguments = args as JsonObject;
              const action = Object.hasOwn(request.actions, tool.name) ? request.actions[tool.name] : undefined;
              if (!action) throw new VortexifyError(`Frontend action is not registered: ${tool.name}.`);
              validateActionArguments(args, action.parameters);
              request.cancelSignal.throwIfAborted();
              tool.status = "running"; publish();
              const value = await withCancellation(Promise.resolve().then(() => {
                request.cancelSignal.throwIfAborted();
                return action.execute(args as JsonObject);
              }), AbortSignal.any([request.cancelSignal, controller.signal]));
              validateToolResult(value);
              result = value;
            } catch (failure) {
              if (request.cancelSignal.aborted || controller.signal.aborted) return;
              result = { success: false, message: asError(failure).message || "Frontend action failed." };
            }
            if (!live() || controller.signal.aborted) return;
            tool.result = result;
            tool.status = result.success ? "success" : "failed";
            tool.error = result.success ? undefined : new VortexifyError(result.message);
            publish();
            try { await request.respondToToolCall(tool.callId, result); }
            catch (failure) {
              // A timeout/another accepted response can win the race; the stream carries its canonical result.
              if (failure instanceof VortexifyError && failure.status === 409) return;
              if (!controller.signal.aborted && !request.cancelSignal.aborted) {
                submissionError = failure;
                request.cancel();
              }
            }
          };
          const submission = actionQueue.then(executeAndRespond);
          actionQueue = submission;
          submissions.add(submission);
          void submission.then(() => submissions.delete(submission), () => submissions.delete(submission));
        } else {
          const args: unknown = event.arguments ?? JSON.parse(tool.argumentText || "{}");
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new VortexifyError("Tool arguments must be a JSON object.");
          tool.arguments = args as JsonObject;
          if (tool.status !== "success") tool.status = "running";
        }
        publish();
      }
      await Promise.all(submissions);
      if (submissionError) throw submissionError;
    } catch (failure) {
      if (submissionError) failure = submissionError;
      if (live()) {
        const canceled = !submissionError && request.cancelSignal.aborted && request.cancelSignal.reason?.name === "AbortError";
        for (const tool of calls.values()) if (["receiving", "running"].includes(tool.status)) tool.status = canceled ? "canceled" : "failed";
        publish();
        if (!canceled) { setError(asError(failure)); throw failure; }
      }
    } finally {
      for (const controller of pendingActions.values()) controller.abort();
      await Promise.all(submissions);
      if (active.current === current) {
        active.current = null;
        if (mounted.current) setIsRunning(false);
      }
    }
  }, [client, switchAgent]);
  return useMemo(() => ({ agentName, conversations, activeConversation, messages,
    conversationId: activeConversation?.id ?? null, messageId, runId, isLoading,
    nextConversationOffset, nextMessageOffset, loadConversations, selectConversation, loadMoreMessages, newConversation, updateConversation,
    text, tools, isRunning, error, consume, cancel }), [agentName, conversations, activeConversation, messages, messageId, runId, isLoading,
    nextConversationOffset, nextMessageOffset, loadConversations, selectConversation, loadMoreMessages, newConversation, updateConversation,
    text, tools, isRunning, error, consume, cancel]);
}
