/** Service-style routes, matching the API server default prefix. */
export const DEFAULT_ENDPOINTS = {
  respondToToolCall: "/api/v2/artifacts/agents/respond_to_tool_call",
  runAgent: "/api/v2/artifacts/agents/run_agent",
  listAgentConversations: "/api/v2/artifacts/agents/list_conversations",
  getAgentConversation: "/api/v2/artifacts/agents/get_conversation",
  listAgentMessages: "/api/v2/artifacts/agents/list_messages",
  createAgentConversation: "/api/v2/artifacts/agents/create_conversation",
  updateAgentConversation: "/api/v2/artifacts/agents/edit_conversation",
  runApi: "/api/v2/projects/{projectId}/apis/{apiName}",
  startTransform: "/api/v2/artifacts/functions/start_transform_function",
  pollTransform: "/api/v2/execution/jobs/get_job",
  streamTransform: "/api/v2/execution/jobs/stream_job_status",
  getTransformResults: "/api/v2/execution/jobs/get_job_results",
  getAnalysisData: "/api/v2/data/tables/get_analysis",
} as const;
export type Endpoints = Record<keyof typeof DEFAULT_ENDPOINTS, string>;

export interface VortexifyConfig {
  /** Required for authenticated production requests; ignored by the dev proxy. */
  baseUrl?: string;
  projectId: string;
  orgId?: string;
  appId?: string;
  appVersionId?: string;
  mode?: "preview" | "run";
  /** Exact HTTPS origin on vortexify.app or a subdomain; required for iframes. */
  parentOrigin?: string;
  development?: boolean;
  /** Same-origin path forwarded by the dev server to the CLI proxy. */
  devProxyPath?: string;
  endpoints?: Partial<Endpoints>;
  timeoutMs?: number;
  inputFormat?: "json" | "multipart";
}

export interface VortexifyEnv {
  DEV?: boolean;
  VITE_API_SERVER_URL?: string;
  VITE_VORTEXIFY_PROJECT_ID?: string;
  VITE_VORTEXIFY_ORG_ID?: string;
  VITE_APP_ID?: string;
  VITE_VERSION_ID?: string;
  VITE_APP_MODE?: "preview" | "run";
  VITE_VORTEXIFY_PARENT_ORIGIN?: string;
  VITE_VORTEXIFY_DEV_PROXY_PATH?: string;
}

/** Call in your application with import.meta.env so Vite controls env injection. */
export function createVortexifyConfig(
  env: VortexifyEnv,
  overrides: Partial<VortexifyConfig> = {},
): VortexifyConfig {
  return {
    baseUrl: env.VITE_API_SERVER_URL ?? "",
    projectId: env.VITE_VORTEXIFY_PROJECT_ID ?? "",
    orgId: env.VITE_VORTEXIFY_ORG_ID,
    appId: env.VITE_APP_ID ?? "",
    appVersionId: env.VITE_VERSION_ID ?? "",
    mode: env.VITE_APP_MODE ?? "preview",
    development: env.DEV === true,
    devProxyPath: env.VITE_VORTEXIFY_DEV_PROXY_PATH ?? "/__vortexify",
    parentOrigin: env.VITE_VORTEXIFY_PARENT_ORIGIN,
    ...overrides,
  };
}
