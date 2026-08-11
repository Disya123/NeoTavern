/**
 * Minimal Server-Sent-Events stream parser (isomorphic — works over a Web
 * ReadableStream in both Node and the browser). Yields the `data:` payload of
 * each event. Multi-line data fields are joined with newlines per the SSE spec.
 */

/** A single buffered line may not exceed this size (hostile/buggy upstream). */
export const SSE_MAX_BUFFERED_BYTES = 1024 * 1024;

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  maxBufferedBytes: number = SSE_MAX_BUFFERED_BYTES,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const flush = (): string | null => {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join('\n');
    dataLines = [];
    return payload;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Unbounded buffering of a newline-less stream is a memory hazard
      // (ТЗ §11.2): a well-behaved SSE upstream emits frequent line breaks.
      if (buffer.length > maxBufferedBytes) {
        throw new Error('SSE stream line exceeds maximum buffered size');
      }

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        if (line === '') {
          const payload = flush();
          if (payload !== null) yield payload;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // Ignore event:/id:/retry:/comment lines for generation purposes.
      }
    }
    // Flush any trailing buffered event.
    buffer += decoder.decode();
    if (buffer.startsWith('data:')) {
      dataLines.push(buffer.slice(5).replace(/^ /, ''));
    }
    const trailing = flush();
    if (trailing !== null) yield trailing;
  } finally {
    reader.releaseLock();
  }
}
