// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface FilesTransportConcurrencySnapshot {
  active: number;
  pending: number;
  maxActive: number;
  waitMs: number;
}

interface OperationStats extends FilesTransportConcurrencySnapshot {}

interface PendingRequest {
  operation: string;
  limit: number;
  enqueuedAt: number;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
}

/** Instance-scoped request gate and low-cardinality queue meter for Desktop Files calls. */
export class FilesTransportConcurrencyMeter {
  private readonly operations = new Map<string, OperationStats>();
  private readonly pending: PendingRequest[] = [];
  private activeTotal = 0;

  constructor(
    private readonly defaultLimit: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(defaultLimit) || defaultLimit < 1) throw new RangeError('Files transport limit must be a positive integer');
  }

  async run<T>(operation: string, request: () => Promise<T>, signal?: AbortSignal | null, limit = this.defaultLimit): Promise<T> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Files transport limit must be a positive integer');
    const release = await this.acquire(operation, signal ?? undefined, limit);
    try {
      const response = await request();
      if (typeof response === 'object' && response !== null && 'body' in response) {
        const fetchResponse = response as Response;
        if (fetchResponse.body) return this.holdUntilBodySettles(fetchResponse, release, signal ?? undefined) as T;
      }
      release();
      return response;
    } catch (error) {
      release();
      throw error;
    }
  }

  snapshot(): Record<string, FilesTransportConcurrencySnapshot> {
    return Object.fromEntries([...this.operations.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([operation, stats]) => [operation, { ...stats }]));
  }

  private async acquire(operation: string, signal: AbortSignal | undefined, limit: number): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    const stats = this.statsFor(operation);
    const enqueuedAt = this.now();
    if (this.activeTotal < limit) return this.grant(operation, stats, enqueuedAt);

    stats.pending += 1;
    return new Promise((resolve, reject) => {
      const waiter: PendingRequest = { operation, limit, enqueuedAt, signal, resolve, reject };
      if (signal) {
        waiter.abortListener = () => {
          const index = this.pending.indexOf(waiter);
          if (index < 0) return;
          this.pending.splice(index, 1);
          this.statsFor(operation).pending -= 1;
          signal.removeEventListener('abort', waiter.abortListener!);
          reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
          this.drain();
        };
        signal.addEventListener('abort', waiter.abortListener, { once: true });
      }
      this.pending.push(waiter);
    });
  }

  private grant(operation: string, stats: OperationStats, enqueuedAt: number): () => void {
    stats.waitMs += Math.max(0, this.now() - enqueuedAt);
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    this.activeTotal += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      stats.active -= 1;
      this.activeTotal -= 1;
      this.drain();
    };
  }

  private drain(): void {
    for (;;) {
      const index = this.pending.findIndex(waiter => this.activeTotal < waiter.limit);
      if (index < 0) return;
      const [waiter] = this.pending.splice(index, 1);
      const stats = this.statsFor(waiter.operation);
      stats.pending -= 1;
      if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener('abort', waiter.abortListener);
      waiter.resolve(this.grant(waiter.operation, stats, waiter.enqueuedAt));
    }
  }

  private statsFor(operation: string): OperationStats {
    let stats = this.operations.get(operation);
    if (!stats) {
      stats = { active: 0, pending: 0, maxActive: 0, waitMs: 0 };
      this.operations.set(operation, stats);
    }
    return stats;
  }

  private holdUntilBodySettles(response: Response, release: () => void, signal?: AbortSignal): Response {
    const reader = response.body!.getReader();
    const removeAbortListener = () => {
      if (signal) signal.removeEventListener('abort', abortListener);
    };
    const abortListener = () => {
      void reader.cancel(signal?.reason).catch(() => undefined).finally(() => {
        removeAbortListener();
        release();
      });
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            controller.close();
            removeAbortListener();
            release();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          controller.error(error);
          removeAbortListener();
          release();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          removeAbortListener();
          release();
        }
      },
    });
    if (signal?.aborted) abortListener();
    else signal?.addEventListener('abort', abortListener, { once: true });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
