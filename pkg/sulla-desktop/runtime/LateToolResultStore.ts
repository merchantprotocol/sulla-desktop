// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { RelayToolResult } from './relayProtocol.js';

export interface LateToolResult {
  requestId: string;
  outcome: 'success' | 'failure';
  result?: RelayToolResult;
  error?: string;
  recordedAt: number;
}

interface StoredLateToolResult extends LateToolResult {
  expiresAt: number;
}

/** Bounded, expiring record of handlers that finish after their caller timed out. */
export class LateToolResultStore {
  private readonly results = new Map<string, StoredLateToolResult>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 128,
  ) {}

  record(requestId: string, result: RelayToolResult | undefined, error?: unknown): LateToolResult {
    const recordedAt = this.now();
    this.evictExpired(recordedAt);
    const item: StoredLateToolResult = {
      requestId,
      outcome: result?.success ? 'success' : 'failure',
      ...(result ? { result } : {}),
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
      recordedAt,
      expiresAt: recordedAt + this.ttlMs,
    };
    this.results.delete(requestId);
    this.results.set(requestId, item);
    while (this.results.size > this.maxEntries) this.results.delete(this.results.keys().next().value!);
    return this.publicResult(item);
  }

  get(requestId: string): LateToolResult | undefined {
    this.evictExpired(this.now());
    const item = this.results.get(requestId);
    return item ? this.publicResult(item) : undefined;
  }

  private evictExpired(now: number): void {
    for (const [requestId, result] of this.results) if (result.expiresAt <= now) this.results.delete(requestId);
  }

  private publicResult({ expiresAt: _expiresAt, ...result }: StoredLateToolResult): LateToolResult {
    return { ...result };
  }
}
