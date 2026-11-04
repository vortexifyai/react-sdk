# Vortexify React SDK

Connect React applications to Vortexify project APIs, transforms, and agents. The SDK provides streaming agent responses, persisted conversations, frontend actions, and page context for agents.

## Installation

Requires React 18 or newer.

```sh
npm install @vortexify/react
```

## Set up your application

Wrap your application with `VortexifyProvider`. Vortexify app starters include this setup already:

```tsx
import { VortexifyProvider, createVortexifyConfig } from "@vortexify/react";
import App from "./App";

const config = createVortexifyConfig(import.meta.env);

export default function Root() {
  return (
    <VortexifyProvider config={config}>
      <App />
    </VortexifyProvider>
  );
}
```

Vortexify supplies the connection settings and authentication. For local development, run `vortexify dev <app-name>` from your Vortexify project and open the URL it prints. The CLI supplies the local configuration; Vortexify supplies the configuration when building hosted applications. You do not need to create SDK environment settings or put authentication tokens in your app.

Inside a component, access the SDK with `useVortexify()`:

```ts
import { useVortexify } from "@vortexify/react";

// Inside your React component:
const { client, agentManager, ready, logout } = useVortexify();
```

`useVortexify()` returns `client`, `agentManager`, `ready`, and `logout`. The provider waits for authentication before rendering your app. Logout is available in deployed apps; local authentication is managed by the CLI.

The client is shared, but **each `useVortexify()` call has its own agent manager**. Keep your chat's manager in one component and pass it to its child components. Keep that component mounted across page navigation if the conversation should stay open.

## Call a project API

Use the API's name as defined in your Vortexify project. The SDK returns the API's result directly:

```tsx
import { useState } from "react";
import { useVortexify } from "@vortexify/react";

type Order = { id: string; total: number };

export function Orders() {
  const { client } = useVortexify();
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function loadOrders() {
    setError(null);
    try {
      const result = await client.runApi<Order[]>("customer_orders", {
        customer_id: "123",
      });
      setOrders(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load orders.");
    }
  }

  return (
    <section>
      <button onClick={() => void loadOrders()}>Load orders</button>
      {error && <p role="alert">{error}</p>}
      {orders.map(order => <p key={order.id}>{order.id}: {order.total}</p>)}
    </section>
  );
}
```

API inputs accept strings, numbers, and booleans. The generic type describes the return value your API provides; it does not validate the response at runtime.

## Run a transform

Start a transform, then wait for its results to become available:

```ts
const { job_id } = await client.startTransform("refresh_orders", {});

const job = await client.pollTransform("refresh_orders", job_id, {
  timeoutMs: 300_000,
  onProgress: progress => console.log(progress.status),
});

if (job.status !== "success") {
  throw new Error(`Transform ended with status: ${job.status}`);
}

const orders = await client.runApi("customer_orders", { customer_id: "123" });
```

`pollTransform` streams progress where available and falls back to polling when needed. It waits for result publication to finish, rather than returning as soon as execution succeeds. Failed and stopped jobs are returned with their terminal status, so check `job.status` before using the results.

| Method | Purpose |
| --- | --- |
| `runApi<T>(name, inputs?, options?)` | Call an API and return its result |
| `startTransform(name, inputs?, options?)` | Start a transform and return its job ID |
| `getTransformJob(name, jobId, options?)` | Read a job's current status |
| `pollTransform(name, jobId, options?)` | Wait for completed results, with optional progress updates |

Request options accept `signal` and `timeoutMs`. Individual requests default to 60 seconds; transform waiting defaults to five minutes. Pass an `AbortSignal` to cancel waiting. Cancellation does not stop a job already running on Vortexify.

## Talk to an agent

Use `agentManager` to consume an agent response and manage conversation state. Inside your chat component:

```tsx
const { client, agentManager } = useVortexify();

async function sendMessage(message: string) {
  try {
    await agentManager.consume(client.runAgent("support_assistant", { message }));
  } catch {
    // Display agentManager.error in your chat UI.
  }
}
```

Render `agentManager.text` for the current response and `agentManager.tools` for tool activity. Use `agentManager.isRunning` to disable the send button while a response is running. Request and stream failures set `agentManager.error` and reject `consume()`.

`client.runAgent()` creates a lazy request: it starts when consumed. The manager continues the selected conversation on later messages. You do not need to resend conversation history.

### Create, select, and manage conversations

```ts
// Start a fresh private conversation on the next message.
agentManager.newConversation({ name: "Order review", visibility: "private" });
await agentManager.consume(client.runAgent("support_assistant", {
  message: "Help me review these orders.",
}));

// Load accessible conversations for an agent, then select one.
await agentManager.loadConversations("support_assistant");
await agentManager.selectConversation(conversationId);

// Rename or change visibility of the selected conversation.
await agentManager.updateConversation({ name: "Shared review", visibility: "public" });
```

New conversations default to `public`, meaning shared with authorized project members. Use `private` for conversations restricted to their creator and authorized project admins/owners. Available actions depend on the user's project permissions.

`newConversation()` prepares a draft; the conversation is created when its first message is sent. Passing `name` or `visibility` directly to `runAgent()` also requests a new conversation. Use `updateConversation()` to edit an existing one.

| Manager member | Purpose |
| --- | --- |
| `conversations`, `activeConversation` | Available conversations and current selection |
| `messages` | Persisted message history |
| `text`, `tools` | Current response text and tool activity |
| `conversationId`, `messageId`, `runId` | Identifiers for the current conversation and latest turn |
| `isRunning`, `isLoading`, `error` | Response state, conversation loading state, and latest error |
| `loadConversations(name, page?)` | Load conversations; a nonzero offset appends a page |
| `selectConversation(id)` | Select a conversation and load its history |
| `loadMoreMessages()` | Load another page of message history |
| `nextConversationOffset`, `nextMessageOffset` | Next page offsets, or `null` |
| `cancel()` | Disconnect the current response and stop further local action dispatch |

Conversation pages default to 50 items, with a maximum of 100. To load the next page of conversations, pass `{ offset: agentManager.nextConversationOffset }` when the offset is not `null`.

The manager refreshes persisted messages after a completed response. Avoid rendering the completed response twice by showing either its persisted message or its current streaming text. Switching conversations or unmounting the manager disconnects the current stream. A disconnected agent run may continue on Vortexify; cancellation does not undo actions already started.

## Give agents data and frontend actions

Attach bounded JSON data and actions that an agent can invoke in your application:

```ts
await agentManager.consume(client.runAgent("support_assistant", {
  message: "Review the selected orders.",
  data: {
    orders: { rows: visibleOrders.slice(0, 100), totalRows: visibleOrders.length },
  },
  actions: {
    openCustomer: {
      description: "Open a customer's details in the application.",
      parameters: {
        type: "object",
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
        additionalProperties: false,
      },
      execute: async ({ customerId }) => {
        if (typeof customerId !== "string") {
          return { success: false, message: "A customer ID is required." };
        }
        await openCustomerPage(customerId);
        return { success: true, message: "Customer details opened." };
      },
    },
  },
}));
```

`visibleOrders` and `openCustomerPage` are application-owned values in this example. Only action descriptions and parameter schemas are sent to the agent; handlers execute in the browser. Resolve a handler after its action has completed, especially when subsequent tools depend on a new page being ready.

Every handler must return an `AgentToolResult`:

```ts
type AgentToolResult =
  | { success: true; message?: string; data?: JsonValue }
  | { success: false; message: string; data?: JsonValue };
```

The manager validates arguments, executes each frontend call once per consumed run, and sends the result back automatically. Thrown errors and invalid results become failures. Returning `void` or a boolean is invalid. Reading message history does not execute actions again.

Action schemas support `type`, `description`, `properties`, `required`, `additionalProperties`, `items`, and `enum`. Supported types are `object`, `array`, `string`, `number`, `integer`, `boolean`, and `null`; the root must be an object. Handlers receive JSON values, so narrow argument types before passing them to typed application functions.

Each action can specify `timeoutMs` between 1,000 and 120,000 milliseconds; the default is 60,000. The total agent-run timeout is separate and defaults to five minutes. Agent streams do not automatically reconnect or replay actions after a disconnection.

Data arrays are limited to 100 items each. Message text, data, and action definitions together must fit within 256 KiB of JSON. JSON nesting is limited to 32 levels. Action results have their own 256 KiB limit. Apply filters and send only the context the agent needs.

## Share the active page with an agent

Register page context inside a component beneath `VortexifyProvider`:

```tsx
import { useAgentView } from "@vortexify/react";

useAgentView({
  id: "orders",
  description: "Orders list with shipping filters and selection.",
  getContext: () => ({
    shippingFilter,
    selectedOrderId,
    visibleOrders: orders.slice(0, 50),
    totalOrders: orders.length,
  }),
});
```

Use your page's current state for the values above. `getContext` can return a JSON object or a promise. The SDK includes a snapshot as `data.current_view` when a run starts. During that run, the agent can request fresh page context through the SDK-provided `get_current_view_context` action.

Keep one active view per provider. Registration ends when the component unmounts, and the most recently mounted view takes precedence. Page changes do not continuously send data. Action definitions supplied to a run stay fixed for that run; use SPA navigation to preserve the active response.

## Render agent analysis charts

Agents with chart generation enabled can return an `AgentChart` in tool results. Retrieve its stored data and render it with your application's chart library:

```ts
const analysis = await client.getAnalysisData(chart.query_id);

if (analysis.status === "success" && analysis.data) {
  // Render analysis.data using chart.config and chart.name.
}
```

Chart configuration includes `chartType`, `xKey`, and `yKeys`. Supported chart types are Bar, StackedBar, GroupedBar, Line, MultiLine, Scatter, and Pie. The SDK retrieves data; your application controls chart rendering.

`getAnalysisData(queryId, { limit, offset }?)` reads an existing analysis without rerunning it. Pending results have no `data`. Pages allow up to 1,000 rows, with `offset` a multiple of `limit`. `has_more` indicates additional stored rows; `result.result_truncated` indicates that the original analysis exceeded its result limit. Agent charts require complete results of at most 1,000 rows.

## Error handling

API failures reject with `VortexifyError`. Its `status` field contains the HTTP status when available:

```ts
import { VortexifyError } from "@vortexify/react";

try {
  await client.runApi("customer_orders", { customer_id: "123" });
} catch (error) {
  if (error instanceof VortexifyError) {
    console.error(error.message, error.status);
  } else {
    throw error;
  }
}
```

Network and cancellation errors can retain their original error types. Authentication failures do not automatically replay API calls or agent messages. For local authentication failures, sign in again with the Vortexify CLI and restart local development.

## Advanced usage

Use these client methods when building your own conversation UI or stream handling:

| Method | Purpose |
| --- | --- |
| `listAgentConversations(name, page?, options?)` | Read accessible conversation pages |
| `getAgentConversation(name, id, options?)` | Read conversation metadata |
| `listAgentMessages(name, id, page?, options?)` | Read persisted history pages |
| `createAgentConversation(name, values?, options?)` | Create an empty conversation immediately |
| `updateAgentConversation(name, id, values, options?)` | Rename or change visibility |
| `respondToToolCall(name, conversationId, runId, callId, result, options?)` | Submit a frontend tool result manually |

`AgentRun` supports `for await` iteration for custom consumers. Direct iteration yields events but does not execute frontend handlers or manage React state. An initialized run also exposes `respondToToolCall(callId, result)`. Most applications should use `agentManager.consume()` to handle this lifecycle.

<!-- sdk-release-history -->
## Changelog

### v0.1.1

- Preserve API error messages and details, validate asynchronous responses, and retain original errors during cleanup.

### v0.1.0

- Initial release.
<!-- /sdk-release-history -->
