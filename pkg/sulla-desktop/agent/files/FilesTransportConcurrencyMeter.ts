// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { performance } from 'node:perf_hooks';

export interface FilesTransportOperation {
  transport: 'node' | 'electron';
  method: string;
  pathname: string;
}

export interface FilesTransportConcurrencySnapshot {
  active: number;
  bodyOpen: number;
  maxActive: number;
  count: number;
  totalMs: number;
  p95Ms: number;
}

interface OperationStats {
  active: number;
  bodyOpen: number;
  maxActive: number;
  count: number;
  totalMs: number;
  samplesMs: number[];
}

type MeteredMethod = (...args: any[]) => any;
type MetricsLogger = (line: string) => void;

/** Measures Files request and body lifetimes without adding a second concurrency gate. */
export class FilesTransportConcurrencyMeter {
  private readonly operations = new Map<string, OperationStats>();
  private readonly knownRoutes = [
    'agent-files',
    'bootstrap',
    'collections',
    'database-file-operations',
    'file-operations',
    'file-edges',
    'files',
    'folders',
    'links',
    'local',
    'original-reveal',
    'search',
    'trash',
  ];
  private lastLoggedAt = Number.NEGATIVE_INFINITY;
  private readonly logIntervalMs = 60_000;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly log: MetricsLogger = line => console.info(line),
  ) {}

  async run<T>(operation: FilesTransportOperation, request: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');

    const operationName = this.operationName(operation);
    const stats = this.statsFor(operationName);
    const startedAt = this.now();
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);

    let requestSettled = false;
    const finishRequest = () => {
      if (requestSettled) return;
      requestSettled = true;
      if (signal) signal.removeEventListener('abort', abortRequest);
      stats.active = Math.max(0, stats.active - 1);
      const durationMs = Math.max(0, this.now() - startedAt);
      stats.count += 1;
      stats.totalMs += durationMs;
      stats.samplesMs.push(durationMs);
      if (stats.samplesMs.length > 256) stats.samplesMs.shift();
    };
    const abortRequest = () => {
      finishRequest();
      this.emitMetricsIfDue();
    };

    signal?.addEventListener('abort', abortRequest, { once: true });
    if (signal?.aborted) {
      abortRequest();
      throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    }

    try {
      const response = await request();
      finishRequest();
      try {
        this.observeResponseBody(response, stats, signal ?? undefined);
      } catch {
        // Observation is strictly best-effort; never turn a successful fetch into a transport failure.
      }
      this.emitMetricsIfDue();
      return response;
    } catch (error) {
      finishRequest();
      this.emitMetricsIfDue();
      throw error;
    } finally {
      if (signal) signal.removeEventListener('abort', abortRequest);
    }
  }

  snapshot(): Record<string, FilesTransportConcurrencySnapshot> {
    return Object.fromEntries([...this.operations.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([operation, stats]) => [operation, this.snapshotFor(stats)]));
  }

  private operationName(operation: FilesTransportOperation): string {
    const segments = operation.pathname.split('/').filter(Boolean);
    const route = segments[0] === 'v1' && this.knownRoutes.includes(segments[1] ?? '')
      ? `/v1/${ segments[1] }`
      : '/other';
    const requestedMethod = operation.method.toUpperCase();
    const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(requestedMethod) ? requestedMethod : 'OTHER';
    // Only this allowlisted prefix is ever retained: IDs, paths and file names cannot enter a metric label.
    return `${ operation.transport } ${ method } ${ route }`;
  }

  private observeResponseBody(value: unknown, stats: OperationStats, signal?: AbortSignal): void {
    if (typeof value !== 'object' || value === null || !('body' in value)) return;
    let body: ReadableStream<Uint8Array> | null;
    try {
      body = (value as Response).body;
    } catch {
      return;
    }
    if (!body) return;

    stats.bodyOpen += 1;
    let settled = false;
    const finishBody = () => {
      if (settled) return;
      settled = true;
      stats.bodyOpen = Math.max(0, stats.bodyOpen - 1);
      if (signal) signal.removeEventListener('abort', abortBody);
      this.emitMetricsIfDue();
    };
    const abortBody = () => finishBody();

    this.observeReadableStream(body, finishBody);
    signal?.addEventListener('abort', abortBody, { once: true });
    if (signal?.aborted) finishBody();
  }

  private observeReadableStream(stream: ReadableStream<Uint8Array>, settled: () => void): void {
    this.replaceMethod(stream, 'getReader', original => {
      const meter = this;
      return function(this: ReadableStream<Uint8Array>, ...args: unknown[]) {
        const reader = original.apply(this, args) as object;
        return meter.observeReader(reader, settled);
      };
    });

    this.wrapPromiseMethod(stream, 'cancel', settled, false);
    this.wrapPromiseMethod(stream, 'pipeTo', settled, true);
    this.replaceMethod(stream, 'pipeThrough', original => {
      const meter = this;
      return function(this: ReadableStream<Uint8Array>, ...args: unknown[]) {
        const output = original.apply(this, args) as ReadableStream<Uint8Array>;
        meter.observeReadableStream(output, settled);
        return output;
      };
    });

    this.replaceMethod(stream, Symbol.asyncIterator, original => {
      const meter = this;
      return function(this: ReadableStream<Uint8Array>, ...args: unknown[]) {
        const iterator = original.apply(this, args) as AsyncIterator<Uint8Array>;
        return meter.observeAsyncIterator(iterator, settled);
      };
    });
  }

  private observeReader(reader: object, settled: () => void): object {
    return new Proxy(reader, {
      get(target, property) {
        if (property === 'read') {
          const read = Reflect.get(target, property, target);
          if (typeof read !== 'function') return read;
          return (...args: unknown[]) => Promise.resolve(read.apply(target, args)).then(
            result => {
              if (typeof result === 'object' && result !== null && 'done' in result && result.done) settled();
              return result;
            },
            error => {
              settled();
              throw error;
            },
          );
        }
        if (property === 'cancel') {
          const cancel = Reflect.get(target, property, target);
          if (typeof cancel !== 'function') return cancel;
          return (...args: unknown[]) => Promise.resolve(cancel.apply(target, args)).then(value => {
            settled();
            return value;
          });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private observeAsyncIterator(iterator: AsyncIterator<Uint8Array>, settled: () => void): AsyncIterator<Uint8Array> {
    return new Proxy(iterator as object, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === 'next' || property === 'return' || property === 'throw') {
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => Promise.resolve(value.apply(target, args)).then(
            result => {
              if (property !== 'next' || (result as IteratorResult<Uint8Array>).done) settled();
              return result;
            },
            error => {
              settled();
              throw error;
            },
          );
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as AsyncIterator<Uint8Array>;
  }

  private wrapPromiseMethod(target: object, method: PropertyKey, settled: () => void, settleOnReject: boolean): void {
    this.replaceMethod(target, method, original => function(this: object, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (!result || typeof result.then !== 'function') return result;
      return Promise.resolve(result).then(
        value => {
          settled();
          return value;
        },
        error => {
          if (settleOnReject) settled();
          throw error;
        },
      );
    });
  }

  private replaceMethod(target: object, method: PropertyKey, decorate: (original: MeteredMethod) => MeteredMethod): void {
    const original = (target as unknown as Record<PropertyKey, unknown>)[method];
    if (typeof original !== 'function') return;
    try {
      Object.defineProperty(target, method, {
        configurable: true,
        writable: true,
        value: decorate(original as MeteredMethod),
      });
    } catch {
      // Body instrumentation is best-effort; failure to observe a stream never changes or blocks its request.
    }
  }

  private emitMetricsIfDue(): void {
    const now = this.now();
    if (now - this.lastLoggedAt < this.logIntervalMs) return;
    this.lastLoggedAt = now;
    const metrics = Object.entries(this.snapshot()).map(([operation, values]) => ({ operation, ...values }));
    if (metrics.length === 0) return;
    try {
      this.log(`[SullaFilesTransport] ${ JSON.stringify(metrics) }`);
    } catch {
      // Diagnostics must never affect Files traffic.
    }
  }

  private snapshotFor(stats: OperationStats): FilesTransportConcurrencySnapshot {
    const sorted = [...stats.samplesMs].sort((left, right) => left - right);
    const p95Index = sorted.length ? Math.ceil(sorted.length * 0.95) - 1 : -1;
    return {
      active: stats.active,
      bodyOpen: stats.bodyOpen,
      maxActive: stats.maxActive,
      count: stats.count,
      totalMs: stats.totalMs,
      p95Ms: p95Index >= 0 ? sorted[p95Index] : 0,
    };
  }

  private statsFor(operation: string): OperationStats {
    let stats = this.operations.get(operation);
    if (!stats) {
      stats = { active: 0, bodyOpen: 0, maxActive: 0, count: 0, totalMs: 0, samplesMs: [] };
      this.operations.set(operation, stats);
    }
    return stats;
  }
}
