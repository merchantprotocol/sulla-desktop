// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface SSEEvent {
  event?: string;
  data:   string;
}

/** Reads and parses a provider SSE body without inferring liveness from silence. */
export class SSEStreamReader {
  async *read(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let cancelReason: unknown;

    try {
      while (true) {
        if (signal?.aborted) {
          cancelReason = signal.reason ?? new DOMException('Operation aborted', 'AbortError');
          throw cancelReason;
        }

        const { done, value } = await this.readChunk(reader, signal);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop()!;

        for (const part of parts) {
          const parsed = this.parseBlock(part.trim());
          if (parsed) yield parsed;
        }
      }

      buffer += decoder.decode();
      const parsed = this.parseBlock(buffer.trim());
      if (parsed) yield parsed;
    } catch (error) {
      if (signal?.aborted) cancelReason = error;
      throw error;
    } finally {
      if (cancelReason !== undefined) {
        // Cancellation resolves a pending reader.read(); don't wait on its promise.
        void reader.cancel(cancelReason).catch(() => undefined);
      }
      try { reader.releaseLock() } catch { /* cancellation may still be resolving a pending read */ }
    }
  }

  private async readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (!signal) return reader.read();
    let abortHandler: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortHandler = () => reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError'));
      signal.addEventListener('abort', abortHandler, { once: true });
      if (signal.aborted) abortHandler();
    });

    try {
      return await Promise.race([reader.read(), aborted]);
    } finally {
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
    }
  }

  private parseBlock(block: string): SSEEvent | null {
    if (!block) return null;
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      else if (line.startsWith('data:')) dataLines.push(line.slice(5));
      // Ignore id:, retry:, and comment lines (starting with :).
    }

    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n').trim() };
  }
}

/** Compatibility entry point used by provider parsers. */
export function readSSEEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEEvent> {
  return new SSEStreamReader().read(body, signal);
}
