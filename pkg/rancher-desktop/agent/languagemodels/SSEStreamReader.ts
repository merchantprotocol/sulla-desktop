/**
 * SSEStreamReader — shared async generator for parsing Server-Sent Events
 * from a ReadableStream<Uint8Array>.
 *
 * Used by OpenAICompatibleService and AnthropicService for streaming LLM responses.
 */

export interface SSEEvent {
  event?: string;
  data:   string;
}

/**
 * Reads SSE events from a ReadableStream, yielding parsed { event, data } objects.
 * Handles chunked reads, multi-line data fields, and partial buffer boundaries.
 *
 * @param body   The response body stream from a streaming fetch call
 * @param signal Optional AbortSignal to cancel reading mid-stream
 */
export async function * readSSEEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) {
        break;
      }

      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const parts = buffer.split('\n\n');

      // Last element is either empty or an incomplete event — keep it in the buffer
      buffer = parts.pop()!;

      for (const part of parts) {
        const trimmed = part.trim();

        if (!trimmed) {
          continue;
        }

        const parsed = parseSSEBlock(trimmed);

        if (parsed) {
          yield parsed;
        }
      }
    }

    // Flush any remaining content in the buffer
    const remaining = buffer.trim();

    if (remaining) {
      const parsed = parseSSEBlock(remaining);

      if (parsed) {
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse a single SSE event block (lines between double-newline separators)
 * into an { event, data } object.
 */
function parseSSEBlock(block: string): SSEEvent | null {
  const lines = block.split('\n');
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice(6));
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5));
    }
    // Ignore id:, retry:, and comment lines (starting with :)
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: dataLines.join('\n').trim(),
  };
}
