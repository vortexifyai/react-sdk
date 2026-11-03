export interface RuntimeAuth {
  token: string;
  orgId?: string;
}

function isVortexifyOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.origin === origin && url.protocol === "https:"
      && ["vortexify.app", "vortexify.dev"].some(domain => url.hostname === domain || url.hostname.endsWith("." + domain));
  } catch {
    return false;
  }
}

export function validateParentOrigin(origin: string | undefined): string {
  if (!origin || !isVortexifyOrigin(origin)) {
    throw new Error("Vortexify requires an exact HTTPS parentOrigin on vortexify.app, vortexify.dev, or one of their subdomains.");
  }
  return origin;
}

export function readRuntimeAuth(
  event: MessageEvent,
  parent: Window,
  origin: string,
): RuntimeAuth | null {
  if (event.source !== parent || event.origin !== origin || !isVortexifyOrigin(event.origin)) return null;
  const data = event.data;
  if (!data || data.type !== "RUNTIME_TOKEN") return null;
  if (![data.token, data.org_id].every(
    (value) => typeof value === "string" && value.trim().length > 0,
  )) return null;
  return { token: data.token, orgId: data.org_id };
}
