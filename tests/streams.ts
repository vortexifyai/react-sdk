import { vi } from "vitest";
export const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
export function streamResponse(text: string, chunkSize = 3, canceled = () => {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset += chunkSize));
    },
    cancel: canceled,
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

export function operationFetch() {
  const operation = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(operation);
  return operation;
}
