// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { VortexifyProvider, useVortexify } from "../src/provider.js";
import type { VortexifyContextValue } from "../src/provider.js";
import { operationFetch, sse, streamResponse } from "./streams.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const config = { orgId: "org", projectId: "project", development: true };
const row = (id = "conversation-1", visibility = "public") => ({ id, resource_id: "resource-id", user_id: "owner", name: "Chat", visibility, is_active: false });
const saved = { id: "message-1", role: "user", content: { text: "Hello" } };
let value: VortexifyContextValue;
let root: ReturnType<typeof createRoot>;
let operation: ReturnType<typeof operationFetch>;
async function mount() {
  operation = operationFetch().mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(init.body);
    if (path.endsWith("list_conversations")) return Response.json({ items: [row()], next_offset: body.offset ? null : 50 });
    if (path.endsWith("get_conversation")) return Response.json(row(body.conversation_id));
    if (path.endsWith("list_messages")) return Response.json({ items: [body.offset ? { ...saved, id: "message-2" } : saved], next_offset: body.offset ? null : 50 });
    if (path.endsWith("edit_conversation")) return Response.json({ ...row(body.conversation_id), ...body.values });
    if (path.endsWith("run_agent")) {
      const conversation = { ...row(body.conversation_id ?? "new-conversation", body.visibility ?? "public"), is_active: true };
      return streamResponse(sse("init", { conversation_id: conversation.id, message_id: "message-3", run_id: "run-1", conversation }) + sse("token", { text: "Response" }) + sse("done", {}));
    }
    throw new Error(`Unexpected route ${path}`);
  });
  function Consumer() { value = useVortexify(); return null; }
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<VortexifyProvider config={config}><Consumer /></VortexifyProvider>));
}
afterEach(async () => { if (root) await act(async () => root.unmount()); vi.restoreAllMocks(); });

it("lists, selects and loads persisted history without executing actions", async () => {
  await mount();
  await act(async () => value.agentManager.loadConversations("support"));
  expect(value.agentManager.conversations).toMatchObject([{ id: "conversation-1", createdBy: "owner", visibility: "public" }]);
  expect(value.agentManager.nextConversationOffset).toBe(50);
  await act(async () => value.agentManager.selectConversation("conversation-1"));
  expect(value.agentManager.activeConversation?.id).toBe("conversation-1");
  expect(value.agentManager.messages).toMatchObject([{ id: "message-1", role: "user" }]);
  await act(async () => value.agentManager.loadMoreMessages());
  expect(value.agentManager.messages.map(message => message.id)).toEqual(["message-1", "message-2"]);
  expect(value.agentManager.nextMessageOffset).toBeNull();
  expect(operation.mock.calls.some(([url]) => String(url).endsWith("run_agent"))).toBe(false);
});

it("continues the selected conversation, captures IDs and refreshes persisted history", async () => {
  await mount();
  await act(async () => value.agentManager.loadConversations("support"));
  await act(async () => value.agentManager.selectConversation("conversation-1"));
  await act(async () => value.agentManager.consume(value.client.runAgent("support", { message: "Continue" })));
  const request = operation.mock.calls.find(([url]) => String(url).endsWith("run_agent"))!;
  expect(JSON.parse(request[1].body)).toMatchObject({ agent_name: "support", conversation_id: "conversation-1", project_id: "project", org_id: "org" });
  expect(JSON.parse(request[1].body)).not.toHaveProperty("visibility");
  expect(value.agentManager).toMatchObject({ conversationId: "conversation-1", messageId: "message-3", runId: "run-1", text: "Response", isRunning: false });
  expect(value.agentManager.activeConversation?.isActive).toBe(false);
});

it("creates public conversations by default, supports private drafts and updates visibility", async () => {
  await mount();
  await act(async () => value.agentManager.consume(value.client.runAgent("support", { message: "New" })));
  let request = operation.mock.calls.find(([url]) => String(url).endsWith("run_agent"))!;
  expect(JSON.parse(request[1].body).visibility).toBe("public");
  await act(async () => value.agentManager.newConversation({ visibility: "private", name: "Private chat" }));
  expect(value.agentManager.activeConversation).toBeNull();
  expect(value.agentManager.messages).toEqual([]);
  await act(async () => value.agentManager.consume(value.client.runAgent("support", { message: "Private" })));
  request = operation.mock.calls.filter(([url]) => String(url).endsWith("run_agent")).at(-1)!;
  expect(JSON.parse(request[1].body)).toMatchObject({ visibility: "private", name: "Private chat" });
  expect(JSON.parse(request[1].body)).not.toHaveProperty("conversation_id");
  await act(async () => value.agentManager.updateConversation({ visibility: "public" }));
  expect(value.agentManager.activeConversation?.visibility).toBe("public");
});

it("clears selection/history on agent change and does not reuse the previous conversation", async () => {
  await mount();
  await act(async () => value.agentManager.loadConversations("support"));
  await act(async () => value.agentManager.selectConversation("conversation-1"));
  await act(async () => value.agentManager.loadConversations("other-agent"));
  expect(value.agentManager.agentName).toBe("other-agent");
  expect(value.agentManager.activeConversation).toBeNull(); expect(value.agentManager.messages).toEqual([]);
  await act(async () => value.agentManager.consume(value.client.runAgent("other-agent", { message: "Hello" })));
  const request = operation.mock.calls.find(([url]) => String(url).endsWith("run_agent"))!;
  expect(JSON.parse(request[1].body)).not.toHaveProperty("conversation_id");
});

it("surfaces denied selection and keeps failed reads from selecting a conversation", async () => {
  await mount();
  await act(async () => value.agentManager.loadConversations("support"));
  operation.mockImplementation(async () => new Response('', { status: 403 }));
  await act(async () => { await expect(value.agentManager.selectConversation("private")).rejects.toThrow("HTTP 403"); });
  expect(value.agentManager.activeConversation).toBeNull();
  expect(value.agentManager.error?.message).toBe("HTTP 403");
  expect(value.agentManager.isLoading).toBe(false);
});

it("clears conversation data when the provider switches client/project", async () => {
  await mount();
  await act(async () => value.agentManager.loadConversations("support"));
  await act(async () => value.agentManager.selectConversation("conversation-1"));
  function Consumer() { value = useVortexify(); return null; }
  // Keep the same consumer type for both provider renders so this exercises manager cleanup.
  await act(async () => root.render(<VortexifyProvider config={config}><Consumer /></VortexifyProvider>));
  await act(async () => value.agentManager.loadConversations("support"));
  await act(async () => value.agentManager.selectConversation("conversation-1"));
  await act(async () => root.render(<VortexifyProvider config={{ ...config, projectId: "other-project" }}><Consumer /></VortexifyProvider>));
  expect(value.agentManager.activeConversation).toBeNull();
  expect(value.agentManager.messages).toEqual([]);
  expect(value.agentManager.conversations).toEqual([]);
  expect(value.agentManager.agentName).toBeNull();
});
