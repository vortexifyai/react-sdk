import { AgentViewContext } from "./agent-view.js";
import type { AgentView } from "./agent-view.js";
import { useAgentManager } from "./agent-manager.js";
import type { AgentManager } from "./agent-manager.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { readRuntimeAuth, validateParentOrigin } from "./auth.js";
import type { RuntimeAuth } from "./auth.js";
import { VortexifyClient } from "./client.js";
import type { VortexifyConfig } from "./config.js";

export interface VortexifyContextValue {
  ready: boolean;
  client: VortexifyClient;
  agentManager: AgentManager;
  /** Request sign-out through the deployed app shell. */
  logout: () => void;
}
const VortexifyContext = createContext<Omit<VortexifyContextValue, "agentManager"> | null>(null);

export function VortexifyProvider({ config, children }: { config: VortexifyConfig; children: ReactNode }) {
  const isIframe = typeof window !== "undefined" && window.self !== window.top;
  const useDevProxy = config.development === true && !isIframe;
  const parentOrigin = isIframe ? validateParentOrigin(config.parentOrigin) : undefined;
  if ((!useDevProxy && !config.baseUrl) || !config.projectId) {
    throw new Error("Vortexify requires projectId and, outside development proxy mode, baseUrl.");
  }
  const [iframeAuth, setIframeAuth] = useState<RuntimeAuth | null>(null);
  const iframeSession = useRef<string | undefined>(undefined);
  const loggingOut = useRef(false);
  const auth = isIframe && !loggingOut.current && iframeSession.current === parentOrigin ? iframeAuth : null;
  const authRef = useRef<RuntimeAuth | null>(auth);
  authRef.current = auth;
  const requestTokenRefresh = useCallback(() => {
    if (isIframe && parentOrigin && !loggingOut.current) window.parent.postMessage({ type: "REFRESH_TOKEN" }, parentOrigin);
  }, [isIframe, parentOrigin]);
  const logout = useCallback(() => {
    if (useDevProxy || !isIframe || !parentOrigin || config.mode === "preview") {
      throw new Error("Logout is available in deployed applications. Local authentication is managed by the Vortexify CLI.");
    }
    if (loggingOut.current) return;
    loggingOut.current = true;
    authRef.current = null;
    setIframeAuth(null);
    window.parent.postMessage({ type: "LOGOUT" }, parentOrigin);
  }, [useDevProxy, isIframe, parentOrigin, config.mode]);
  useEffect(() => {
    if (!isIframe || !parentOrigin) return;
    loggingOut.current = false;
    iframeSession.current = parentOrigin;
    setIframeAuth(null);
    authRef.current = null;
    const handler = (event: MessageEvent) => {
      if (loggingOut.current) return;
      const next = readRuntimeAuth(event, window.parent, parentOrigin);
      if (next) { authRef.current = next; setIframeAuth(next); }
    };
    window.addEventListener("message", handler);
    window.parent.postMessage({ type: "IFRAME_READY" }, parentOrigin);
    return () => { window.removeEventListener("message", handler); authRef.current = null; };
  }, [isIframe, parentOrigin]);
  const activeView = useRef<{ token: symbol; view: AgentView } | null>(null);
  const viewRegistry = useMemo(() => ({ register(view: AgentView) {
    const registration = { token: Symbol(), view };
    activeView.current = registration;
    return () => { if (activeView.current === registration) activeView.current = null; };
  } }), []);
  const client = useMemo(() => new VortexifyClient(config, () => authRef.current, requestTokenRefresh,
    useDevProxy ? "dev-proxy" : "authenticated", () => activeView.current?.view ?? null), [config, requestTokenRefresh, useDevProxy]);
  const value = useMemo(() => ({ ready: useDevProxy || auth !== null, client, logout }), [auth, client, useDevProxy, logout]);
  if (!useDevProxy && !isIframe) {
    return <main role="alert">Open this application through its published URL.</main>;
  }
  if (!value.ready) return <main role="status">{loggingOut.current ? "Signing out…" : "Opening application…"}</main>;
  return <AgentViewContext.Provider value={viewRegistry}><VortexifyContext.Provider value={value}>{children}</VortexifyContext.Provider></AgentViewContext.Provider>;
}

export function useVortexify(): VortexifyContextValue {
  const context = useContext(VortexifyContext);
  const agentManager = useAgentManager(context?.client ?? null);
  if (!context) throw new Error("useVortexify must be used inside VortexifyProvider.");
  return useMemo(() => ({ ...context, agentManager }), [context, agentManager]);
}
