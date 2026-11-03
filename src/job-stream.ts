import { VortexifyError } from "./errors.js";

interface JobEvent { type: string; id?: string; data: unknown }

/** Fetch-based SSE supports POST bodies and bearer authentication. */
export async function* readJobEvents(response: Response, signal: AbortSignal): AsyncGenerator<JobEvent> {
  if (response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream" || !response.body) {
    await response.body?.cancel();
    throw new VortexifyError("Job endpoint must return a text/event-stream response body.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", type = "message", id: string | undefined, data: string[] = [], size = 0;
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
        if (buffer[index] === "\r" && index === buffer.length - 1 && !chunk.done) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1));
        size += line.length;
        if (size > 1_048_576) throw new VortexifyError("Job event exceeds the size limit.");
        if (!line) {
          if (data.length) {
            let value: unknown;
            try { value = JSON.parse(data.join("\n")); }
            catch { throw new VortexifyError("Invalid JSON in job event."); }
            yield { type, id, data: value };
            if (type === "done" || type === "error") return;
          }
          type = "message"; data = []; size = 0;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") type = value;
          if (field === "data") data.push(value);
          if (field === "id" && !value.includes("\0")) id = value;
        }
      }
      if (size + buffer.length > 1_048_576) throw new VortexifyError("Job event exceeds the size limit.");
      if (chunk.done) return;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

export function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
