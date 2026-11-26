// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { TimedOut } from './failures';

/** SSE sockets that stop delivering bytes are network failures, not agent silence. */
export const DEFAULT_SSE_IDLE_READ_TIMEOUT_MS = 120_000;

export interface SSEEvent {
  event?: string;
  data:   string;
}

/** Retryable provider fault raised when a stream connection stays open but stops yielding bytes. */
export class SSEStreamIdleTimeoutError extends TimedOut {
  readonly code = 'SSE_STREAM_IDLE_TIMEOUT';
  readonly retrySafe = true;
  readonly unsafeToFallback = false;

  constructor(readonly idleTimeoutMs: number) {
    super('selected model provider', { cause: new Error(`SSE stream had no readable bytes for ${ idleTimeoutMs }ms`) });
    this.message = `SSE stream idle-read timed out after ${ idleTimeoutMs }ms; the provider connection stopped delivering bytes.`;
    this.name = 'SSEStreamIdleTimeoutError';
  }
}

/** Reads, parses, and bounds idle waits for one provider SSE body. */
export class SSEStreamReader {
  constructor(private readonly idleReadTimeoutMs: number = DEFAULT_SSE_IDLE_READ_TIMEOUT_MS) {
    if (!Number.isFinite(idleReadTimeoutMs) || idleReadTimeoutMs <= 0) {
      throw new RangeError('SSE idle-read timeout must be a positive finite number');
    }
  }

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
      const remaining = buffer.trim();
      const parsed = this.parseBlock(remaining);
      if (parsed) yield parsed;
    } catch (error) {
      if (error instanceof SSEStreamIdleTimeoutError || signal?.aborted) cancelReason = error;
      throw error;
    } finally {
      if (cancelReason !== undefined) {
        // Cancel resolves the outstanding read; don't wait for an unhealthy
        // network source's cancellation promise before returning the fault.
        void reader.cancel(cancelReason).catch(() => undefined);
      }
      try { reader.releaseLock() } catch { /* cancellation may still be resolving a pending read */ }
    }
  }

  private async readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SSEStreamIdleTimeoutError(this.idleReadTimeoutMs)), this.idleReadTimeoutMs);
    });
    const aborted = signal && new Promise<never>((_resolve, reject) => {
      abortHandler = () => reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError'));
      signal.addEventListener('abort', abortHandler, { once: true });
      if (signal.aborted) abortHandler();
    });

    try {
      return await Promise.race([reader.read(), timeout, ...(aborted ? [aborted] : [])]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
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
