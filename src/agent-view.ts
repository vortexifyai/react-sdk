import { createContext, useContext, useEffect, useRef } from "react";
import type { JsonObject } from "./agent.js";

export interface AgentView {
  id: string;
  description?: string;
  getContext: () => JsonObject | Promise<JsonObject>;
}
export interface AgentViewRegistry {
  register: (view: AgentView) => () => void;
}
/** Internal provider registry; each registration owns its cleanup. */
export const AgentViewContext = createContext<AgentViewRegistry | null>(null);

/** Register one active route/view. Context is read on demand from the latest render. */
export function useAgentView(view: AgentView): void {
  const registry = useContext(AgentViewContext);
  const latest = useRef(view);
  latest.current = view;
  if (!registry) throw new Error("useAgentView must be used inside VortexifyProvider.");
  if (!view.id.trim()) throw new Error("An agent view ID is required.");
  useEffect(() => registry.register({
    id: view.id,
    get description() { return latest.current.description; },
    getContext: () => latest.current.getContext(),
  }), [registry, view.id]);
}
