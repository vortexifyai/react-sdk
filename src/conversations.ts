import type { AgentToolResult } from "./agent.js";

export type ConversationVisibility = "public" | "private";
export interface AgentConversation {
  id: string;
  agentId: string;
  name: string | null;
  visibility: ConversationVisibility;
  createdBy: string | null;
  isActive: boolean;
  createdAt?: string;
}
export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  interactiveRunId?: string | null;
  interactiveCallId?: string | null;
  responseStatus?: "pending" | "responded" | "timed_out" | "canceled" | null;
  responseDeadline?: string | null;
  response?: AgentToolResult | null;
  respondedAt?: string | null;
  createdAt?: string;
}
export interface ConversationOptions { name?: string; visibility?: ConversationVisibility }
export interface PageOptions { limit?: number; offset?: number }
export interface Page<T> { items: T[]; nextOffset: number | null }
export function conversationFromServer(row: Record<string, unknown>): AgentConversation {
  return {
    id: String(row.id), agentId: String(row.resource_id), name: row.name as string | null,
    visibility: row.visibility as ConversationVisibility, createdBy: (row.created_by ?? row.user_id ?? null) as string | null,
    isActive: row.is_active === true, createdAt: row.created_at as string | undefined,
  };
}
export function messageFromServer(row: Record<string, unknown>): AgentMessage {
  return { id: String(row.id), role: row.role as AgentMessage["role"], content: row.content,
    ...(row.interactive_run_id === undefined ? {} : { interactiveRunId: row.interactive_run_id as string | null }),
    ...(row.interactive_call_id === undefined ? {} : { interactiveCallId: row.interactive_call_id as string | null }),
    ...(row.response_status === undefined ? {} : { responseStatus: row.response_status as AgentMessage["responseStatus"] }),
    ...(row.response_deadline === undefined ? {} : { responseDeadline: row.response_deadline as string | null }),
    ...(row.response === undefined ? {} : { response: row.response as AgentToolResult | null }),
    ...(row.responded_at === undefined ? {} : { respondedAt: row.responded_at as string | null }),
    createdAt: row.created_at as string | undefined };
}
